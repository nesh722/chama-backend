const crypto = require('crypto');
const db = require('../config/db');
const { b2cPayment, parseB2CResult } = require('../utils/mpesaB2C');
const { normalizePhone } = require('../utils/mpesa');
const { RequestError } = require('../utils/idempotency');
const { assertPayoutsActive, requireApproval, markApprovalUsedForTurn } = require('../utils/payoutApproval');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');

const PURPOSES = ['payout', 'loan_disbursement'];
const MAX_AMOUNT = Number(process.env.MPESA_B2C_MAX) || 150000; // per transfer; match your shortcode's limit
const STALE_MINUTES = 10; // a transfer with no answer for this long can be released by a treasurer / chair

const isSandbox = () => process.env.MPESA_ENV !== 'production';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- helpers ----------

async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

const isApprover = (role) => role === 'treasurer' || role === 'chair';

// Problems a retry cannot fix (the books and the money disagree) are marked so they are never retried blindly
const REVIEW = 'Needs review: ';
const isFinalProblem = (row) => {
  const e = row.fulfil_error || '';
  return e.startsWith('Amount mismatch') || e.startsWith(REVIEW);
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function secretOk(req) {
  const expected = process.env.MPESA_CALLBACK_SECRET;
  return !!expected && safeEqual(req.params.secret, expected.trim());
}

function minutesSince(date) {
  return (Date.now() - new Date(date).getTime()) / 60000;
}

function toClient(row) {
  const needsAttention = row.status === 'success' && !row.fulfilled && !!row.fulfil_error;
  const stale = row.status === 'pending' && minutesSince(row.created_at) >= STALE_MINUTES;

  let message;
  if (row.status === 'pending') {
    message = stale
      ? 'No answer from M-Pesa yet. Check your M-Pesa statement. If nothing was sent, you can release this and try again.'
      : 'Waiting for M-Pesa to confirm the transfer...';
  } else if (row.status === 'success' && row.fulfilled) {
    message = 'Sent via M-Pesa and recorded.';
  } else if (needsAttention) {
    message = `The money was sent${row.mpesa_receipt ? ` (${row.mpesa_receipt})` : ''}, but it could not be recorded automatically. ${row.fulfil_error}`;
  } else if (row.status === 'success') {
    message = 'Sent. Recording it now...';
  } else if (row.status === 'timeout') {
    message = 'M-Pesa timed out before sending. Nothing was sent, so you can try again.';
  } else {
    message = row.result_desc || 'The transfer failed. Nothing was sent.';
  }

  return {
    id: row.id,
    purpose: row.purpose,
    referenceId: row.reference_id,
    userId: row.user_id,
    amount: parseFloat(row.amount),
    status: row.status,
    fulfilled: !!row.fulfilled,
    receipt: row.mpesa_receipt,
    needsAttention,
    stale,
    message,
    createdAt: row.created_at
  };
}

// ---------- settling a transfer ----------

// The sync reply and the result callback race each other; give the sync side a moment to save the ids.
async function locateRow(outcome) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const [rows] = await db.query(
      `SELECT id FROM mpesa_b2c_transactions
       WHERE (conversation_id IS NOT NULL AND conversation_id = ?)
          OR (originator_conversation_id IS NOT NULL AND originator_conversation_id = ?)
       LIMIT 1`,
      [outcome.conversationId, outcome.originatorConversationId]
    );
    if (rows.length > 0) return rows[0].id;
    await sleep(700);
  }
  return null;
}

// Step 1: store Safaricom's verdict on the transfer row (once).
async function recordOutcome(rowId, outcome, { timedOut = false } = {}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM mpesa_b2c_transactions WHERE id = ? FOR UPDATE', [rowId]);
    if (rows.length === 0) {
      await conn.commit();
      return null;
    }
    const row = rows[0];

    // A transfer we gave up on (released / timed out) can still turn out to have gone through.
    // Real money moved, so a late success is accepted and recorded.
    const lateSuccess = !timedOut && outcome.resultCode === 0 && (row.status === 'failed' || row.status === 'timeout');
    if (row.status !== 'pending' && !lateSuccess) {
      await conn.commit();
      return row;
    }

    let status = 'failed';
    if (timedOut) status = 'timeout';
    else if (outcome.resultCode === 0) status = 'success';

    let fulfilError = null;
    if (
      status === 'success' &&
      outcome.amount !== null &&
      Math.round(outcome.amount) !== Math.round(Number(row.amount))
    ) {
      fulfilError = `Amount mismatch: sent KES ${outcome.amount} but KES ${row.amount} was expected. Needs manual review.`;
    }

    await conn.query(
      `UPDATE mpesa_b2c_transactions
       SET status = ?, result_code = ?, result_desc = ?, mpesa_receipt = ?, receiver_name = ?, fulfil_error = ?,
           conversation_id = COALESCE(conversation_id, ?),
           originator_conversation_id = COALESCE(originator_conversation_id, ?)
       WHERE id = ?`,
      [
        status,
        Number.isNaN(outcome.resultCode) ? null : outcome.resultCode,
        String(outcome.resultDesc || '').slice(0, 255),
        outcome.receipt || null,
        outcome.receiverName ? outcome.receiverName.slice(0, 100) : null,
        fulfilError,
        outcome.conversationId,
        outcome.originatorConversationId,
        rowId
      ]
    );

    await conn.commit();
    return { ...row, status, fulfil_error: fulfilError };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Step 2: for a successful transfer, mark the payout turn / loan as paid out, exactly once.
async function fulfilIfNeeded(rowId) {
  const conn = await db.getConnection();
  let row = null;
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM mpesa_b2c_transactions WHERE id = ? FOR UPDATE', [rowId]);
    row = rows[0];
    if (!row || row.status !== 'success' || row.fulfilled || isFinalProblem(row)) {
      await conn.commit();
      return null;
    }

    if (row.purpose === 'payout') {
      const [turn] = await conn.query(
        'SELECT id, has_received FROM payout_rotations WHERE id = ? FOR UPDATE',
        [row.reference_id]
      );
      if (turn.length === 0) {
        throw new Error(`${REVIEW}The rotation turn no longer exists (the rotation was reset). Reconcile this transfer manually.`);
      }
      if (turn[0].has_received) {
        throw new Error(`${REVIEW}This turn was already marked as received manually, so this M-Pesa transfer is a duplicate. Reconcile it manually.`);
      }
      await conn.query(
        'UPDATE payout_rotations SET has_received = TRUE, received_at = NOW() WHERE id = ? AND has_received = FALSE',
        [row.reference_id]
      );
      await conn.query(
        'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
        [row.group_id, row.user_id, 'payout', row.amount, row.reference_id]
      );
      await markApprovalUsedForTurn(conn, row.reference_id); // one approval pays out one turn, once
    } else {
      // The ledger entry for a loan is already written when it is approved, so only the loan is marked here.
      const [loan] = await conn.query('SELECT id, disbursed_at FROM loans WHERE id = ? FOR UPDATE', [row.reference_id]);
      if (loan.length === 0) {
        throw new Error(`${REVIEW}The loan no longer exists. Reconcile this transfer manually.`);
      }
      if (loan[0].disbursed_at) {
        throw new Error(`${REVIEW}This loan was already marked as sent, so this M-Pesa transfer is a duplicate. Reconcile it manually.`);
      }
      await conn.query('UPDATE loans SET disbursed_at = NOW(), disbursement_receipt = ? WHERE id = ?', [
        row.mpesa_receipt,
        row.reference_id
      ]);
    }

    await conn.query('UPDATE mpesa_b2c_transactions SET fulfilled = 1, fulfil_error = NULL WHERE id = ?', [rowId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.log(`M-Pesa B2C fulfilment failed for transfer ${rowId}:`, err.message);
    try {
      await db.query('UPDATE mpesa_b2c_transactions SET fulfil_error = ? WHERE id = ?', [
        String(err.message).slice(0, 255),
        rowId
      ]);
    } catch (_) {
      /* nothing more we can do */
    }
    return null;
  } finally {
    conn.release();
  }

  // The transfer is committed. Everything below is best-effort and must never undo it.
  await announce(row);
  return row;
}

async function announce(row) {
  const amt = parseFloat(row.amount);
  const code = row.mpesa_receipt ? ` (${row.mpesa_receipt})` : '';
  try {
    if (row.purpose === 'payout') {
      await logActivity({
        userId: row.user_id,
        groupId: row.group_id,
        actionType: 'payout_received',
        description: `You received a payout of KES ${amt} via M-Pesa`,
        amount: amt
      });
      await createNotification(row.user_id, 'Payout Sent', `Your payout of KES ${amt} was sent to your M-Pesa${code}.`);
    } else {
      await logActivity({
        userId: row.user_id,
        groupId: row.group_id,
        actionType: 'loan_disbursed',
        description: `Your loan of KES ${amt} was sent to your M-Pesa`,
        amount: amt
      });
      await createNotification(row.user_id, 'Loan Sent', `Your loan of KES ${amt} was sent to your M-Pesa${code}.`);
    }
  } catch (err) {
    console.log('M-Pesa B2C post-transfer notices failed:', err.message);
  }
}

async function settle(outcome, options) {
  const rowId = await locateRow(outcome);
  if (!rowId) {
    console.log('M-Pesa B2C result did not match any transfer:', outcome.conversationId || outcome.originatorConversationId);
    return;
  }
  const row = await recordOutcome(rowId, outcome, options);
  if (row) await fulfilIfNeeded(rowId);
}

// ---------- routes ----------

// POST /api/mpesa/b2c/send
// body: { purpose: 'payout' | 'loan_disbursement', group_id?, loan_id?, phone? }
// `phone` is only honoured while MPESA_ENV is not 'production' (the sandbox only pays its own test numbers).
exports.send = async (req, res) => {
  let rowId = null;
  try {
    const requesterId = Number(req.user.userId);
    const { purpose } = req.body;
    let groupId = req.body.group_id;
    const loanId = req.body.loan_id;

    if (!PURPOSES.includes(purpose)) {
      return res.status(400).json({ success: false, message: 'purpose must be payout or loan_disbursement' });
    }

    if (purpose === 'loan_disbursement') {
      if (!loanId) return res.status(400).json({ success: false, message: 'loan_id is required for a loan' });
      const [loanRows] = await db.query('SELECT group_id FROM loans WHERE id = ?', [loanId]);
      if (loanRows.length === 0) return res.status(404).json({ success: false, message: 'Loan not found' });
      groupId = loanRows[0].group_id;
    } else if (!groupId) {
      return res.status(400).json({ success: false, message: 'group_id is required for a payout' });
    }

    const role = await getMembership(groupId, requesterId);
    if (!isApprover(role)) {
      return res.status(403).json({ success: false, message: 'Only the treasurer or chair can send money with M-Pesa' });
    }
    if (purpose === 'payout') await assertPayoutsActive(groupId); // every payout needs a second approver, so the group needs two

    let overridePhone = null;
    if (req.body.phone && isSandbox()) {
      overridePhone = normalizePhone(req.body.phone);
      if (!overridePhone) {
        return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number, e.g. 0708374149' });
      }
    }

    const requestRef = crypto.randomUUID();
    let amount;
    let phone;
    let recipientName;

    // Everything that decides "is it allowed, and to whom, and how much" happens with the target locked,
    // so two taps (or two treasurers) can never start two transfers for the same turn or loan.
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      let referenceId;
      let recipientId;

      if (purpose === 'payout') {
        const [next] = await conn.query(
          `SELECT id, user_id FROM payout_rotations
           WHERE group_id = ? AND has_received = FALSE
           ORDER BY rotation_order ASC LIMIT 1 FOR UPDATE`,
          [groupId]
        );
        if (next.length === 0) {
          throw new RequestError(409, 'All members have already received their payout for this rotation cycle');
        }
        referenceId = next[0].id;
        recipientId = next[0].user_id;

        const [g] = await conn.query('SELECT contribution_amount FROM groups_table WHERE id = ?', [groupId]);
        const [c] = await conn.query('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?', [groupId]);
        amount = parseFloat(g[0].contribution_amount) * c[0].count;

        // A different treasurer or chair must have approved this exact payout
        await requireApproval(conn, { rotationId: referenceId, amount });
      } else {
        const [loans] = await conn.query(
          'SELECT id, user_id, amount, status, disbursed_at FROM loans WHERE id = ? FOR UPDATE',
          [loanId]
        );
        const loan = loans[0];
        if (loan.status !== 'approved') {
          throw new RequestError(409, 'Only an approved loan can be sent');
        }
        if (loan.disbursed_at) {
          throw new RequestError(409, 'This loan has already been sent');
        }
        if (Number(loan.user_id) === requesterId) {
          throw new RequestError(403, 'You cannot send a loan to yourself. Another treasurer or chair has to do it.');
        }
        referenceId = loan.id;
        recipientId = loan.user_id;
        amount = parseFloat(loan.amount);
      }

      if (!Number.isInteger(amount) || amount < 1) {
        throw new RequestError(
          400,
          `M-Pesa can only send whole shillings, and this amount is KES ${amount}. Record it by hand instead.`
        );
      }
      if (amount > MAX_AMOUNT) {
        throw new RequestError(400, `The most M-Pesa can send in one transfer here is KES ${MAX_AMOUNT.toLocaleString()}.`);
      }

      const [busy] = await conn.query(
        `SELECT id, status FROM mpesa_b2c_transactions
         WHERE purpose = ? AND reference_id = ? AND status IN ('pending', 'success') LIMIT 1`,
        [purpose, referenceId]
      );
      if (busy.length > 0) {
        throw new RequestError(
          409,
          busy[0].status === 'pending'
            ? 'A transfer for this is already in progress. Wait for M-Pesa to confirm it.'
            : 'M-Pesa has already sent this.'
        );
      }

      const [users] = await conn.query('SELECT full_name, phone FROM users WHERE id = ?', [recipientId]);
      recipientName = users[0] ? users[0].full_name : 'the member';
      phone = overridePhone || normalizePhone(users[0] && users[0].phone);
      if (!phone) {
        throw new RequestError(400, `${recipientName} does not have a valid Safaricom number on their profile.`);
      }

      const [ins] = await conn.query(
        `INSERT INTO mpesa_b2c_transactions
           (purpose, group_id, user_id, reference_id, amount, phone, initiated_by, request_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [purpose, groupId, recipientId, referenceId, amount, phone, requesterId, requestRef]
      );
      rowId = ins.insertId;

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // The Daraja call happens outside the transaction so no database lock is held while we wait on the network.
    let push;
    try {
      push = await b2cPayment({
        requestRef,
        phone,
        amount,
        remarks: purpose === 'payout' ? 'Chama payout' : 'Chama loan',
        occasion: `Group ${groupId}`
      });
    } catch (sendErr) {
      if (sendErr.ambiguous) {
        // We do not know whether M-Pesa started the transfer, so the row stays pending and blocks a blind retry.
        await db.query('UPDATE mpesa_b2c_transactions SET result_desc = ? WHERE id = ?', [
          'Unclear whether M-Pesa started this transfer. Check your M-Pesa statement before trying again.',
          rowId
        ]);
        return res.status(202).json({
          success: true,
          unclear: true,
          message: 'We could not confirm that M-Pesa received the request. Check your M-Pesa statement before trying again.',
          transferId: rowId
        });
      }
      await db.query("UPDATE mpesa_b2c_transactions SET status = 'failed', result_desc = ? WHERE id = ?", [
        String(sendErr.message).slice(0, 255),
        rowId
      ]);
      return res.status(502).json({ success: false, message: `M-Pesa did not accept the transfer: ${sendErr.message}` });
    }

    await db.query(
      'UPDATE mpesa_b2c_transactions SET conversation_id = ?, originator_conversation_id = ? WHERE id = ?',
      [push.ConversationID || null, push.OriginatorConversationID || null, rowId]
    );

    res.status(202).json({
      success: true,
      message: `M-Pesa accepted the transfer to ${recipientName}. It is being processed.`,
      transferId: rowId
    });
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.log('M-Pesa B2C send failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/mpesa/b2c/result/:secret   (called by Safaricom, so no login token)
exports.result = async (req, res) => {
  if (!secretOk(req)) {
    console.log('M-Pesa B2C result rejected: the secret in the URL does not match MPESA_CALLBACK_SECRET');
    return res.status(403).json({ ResultCode: 1, ResultDesc: 'Rejected' });
  }
  try {
    const outcome = parseB2CResult(req.body);
    if (outcome) {
      console.log(
        `M-Pesa B2C result received: ${outcome.conversationId || outcome.originatorConversationId} (result ${outcome.resultCode})`
      );
      await settle(outcome);
    }
  } catch (err) {
    console.log('M-Pesa B2C result error:', err.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
};

// POST /api/mpesa/b2c/timeout/:secret   (Safaricom says it gave up waiting in its queue: nothing was sent)
exports.timeout = async (req, res) => {
  if (!secretOk(req)) {
    return res.status(403).json({ ResultCode: 1, ResultDesc: 'Rejected' });
  }
  try {
    const outcome = parseB2CResult(req.body);
    if (outcome) {
      console.log(`M-Pesa B2C timeout received: ${outcome.conversationId || outcome.originatorConversationId}`);
      await settle(outcome, { timedOut: true });
    }
  } catch (err) {
    console.log('M-Pesa B2C timeout error:', err.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
};

// GET /api/mpesa/b2c/group/:groupId
// The latest transfer for each payout turn / loan in the group. Treasurer and chair see all of them,
// everyone else sees only transfers sent to them.
exports.listForGroup = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { groupId } = req.params;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT * FROM mpesa_b2c_transactions
       WHERE group_id = ? ${isApprover(role) ? '' : 'AND user_id = ?'}
       ORDER BY id DESC LIMIT 200`,
      isApprover(role) ? [groupId] : [groupId, userId]
    );

    const seen = new Set();
    const latest = [];
    for (const row of rows) {
      const key = `${row.purpose}:${row.reference_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(toClient(row));
    }

    res.json({ success: true, sandbox: isSandbox(), transfers: latest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/mpesa/b2c/status/:id
exports.status = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await db.query('SELECT * FROM mpesa_b2c_transactions WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transfer not found' });
    }
    let row = rows[0];

    const role = await getMembership(row.group_id, userId);
    if (!isApprover(role) && Number(row.user_id) !== userId) {
      return res.status(403).json({ success: false, message: 'Not allowed to see this transfer' });
    }

    if (row.status === 'success' && !row.fulfilled && !isFinalProblem(row)) {
      await fulfilIfNeeded(row.id); // retry a recording that failed earlier
      const [again] = await db.query('SELECT * FROM mpesa_b2c_transactions WHERE id = ?', [row.id]);
      row = again[0];
    }

    res.json({ success: true, transfer: toClient(row) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/mpesa/b2c/release/:id
// A transfer M-Pesa never answered for stays 'pending' and blocks a retry. After STALE_MINUTES a treasurer or
// chair who has checked the M-Pesa statement and seen that nothing was sent can release it so it can be retried.
// If the transfer turns out to have gone through anyway, a late result still records it.
exports.release = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await db.query('SELECT * FROM mpesa_b2c_transactions WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transfer not found' });
    }
    const row = rows[0];

    const role = await getMembership(row.group_id, userId);
    if (!isApprover(role)) {
      return res.status(403).json({ success: false, message: 'Only the treasurer or chair can release a transfer' });
    }
    if (row.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This transfer is not waiting for an answer' });
    }
    if (minutesSince(row.created_at) < STALE_MINUTES) {
      return res.status(409).json({
        success: false,
        message: `Wait at least ${STALE_MINUTES} minutes for M-Pesa to answer before releasing this transfer.`
      });
    }

    const [done] = await db.query(
      `UPDATE mpesa_b2c_transactions SET status = 'failed', result_desc = ? WHERE id = ? AND status = 'pending'`,
      [`Released by user ${userId} after no answer from M-Pesa`, row.id]
    );
    if (done.affectedRows === 0) {
      return res.status(409).json({ success: false, message: 'This transfer just got an answer. Refresh to see it.' });
    }

    res.json({ success: true, message: 'Released. You can send it again.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};