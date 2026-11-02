const crypto = require('crypto');
const db = require('../config/db');
const { stkPush, stkQuery, parseCallback, normalizePhone } = require('../utils/mpesa');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');
const { accrueLoanInterest } = require('../utils/loanInterest');
const {
  recordContribution,
  recordSavings,
  applyRepayment,
  loanBalances
} = require('../utils/payments');

const PURPOSES = ['contribution', 'savings', 'loan_repayment'];
const MAX_AMOUNT = 250000; // per payment; adjust to your shortcode's limits

const PURPOSE_LABEL = {
  contribution: 'Contribution',
  savings: 'Savings',
  loan_repayment: 'Loan repay'
};

// ---------- helpers ----------

async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Don't hit Daraja's query endpoint on every 3-second poll
const lastQueryAt = new Map();
const payStartedAt = new Map();
function shouldQuery(paymentId) {
  const now = Date.now();
  // Give Safaricom's callback (which carries the receipt) a head start before we ask Daraja ourselves
  const started = payStartedAt.get(paymentId);
  if (started && now - started < 20000) return false;
  if (now - (lastQueryAt.get(paymentId) || 0) < 8000) return false;
  lastQueryAt.set(paymentId, now);
  return true;
}

function toClient(row) {
  let message;
  if (row.status === 'pending') {
    message = 'Waiting for you to enter your M-Pesa PIN...';
  } else if (row.status === 'success' && row.fulfilled) {
    message = 'Payment received and recorded.';
  } else if (row.status === 'success' && row.fulfil_error) {
    message = `Payment received (${row.mpesa_receipt || 'ref ' + row.id}) but could not be recorded automatically. Please contact your treasurer.`;
  } else if (row.status === 'success') {
    message = 'Payment received. Recording it now...';
  } else if (row.status === 'cancelled') {
    message = 'You cancelled the payment.';
  } else {
    message = row.result_desc || 'The payment failed.';
  }

  return {
    id: row.id,
    purpose: row.purpose,
    groupId: row.group_id,
    loanId: row.purpose === 'loan_repayment' ? row.reference_id : null,
    amount: parseFloat(row.amount),
    status: row.status,
    fulfilled: !!row.fulfilled,
    receipt: row.mpesa_receipt,
    needsAttention: row.status === 'success' && !row.fulfilled && !!row.fulfil_error,
    message
  };
}

// ---------- settling a payment ----------

// Step 1: store Safaricom's verdict on the payment row (once).
async function recordOutcome(checkoutRequestId, outcome) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM mpesa_transactions WHERE checkout_request_id = ? FOR UPDATE',
      [checkoutRequestId]
    );
    // The status check can settle a payment before the callback arrives, and it never carries the
    // receipt. If the callback shows up late, fill the receipt in.
    if (
      rows.length > 0 &&
      rows[0].status === 'success' &&
      !rows[0].mpesa_receipt &&
      outcome.resultCode === 0 &&
      outcome.receipt
    ) {
      await conn.query('UPDATE mpesa_transactions SET mpesa_receipt = ? WHERE id = ?', [outcome.receipt, rows[0].id]);
      rows[0].mpesa_receipt = outcome.receipt;
    }

    // A payment closed as "failed" only because Daraja said 4999 (still processing) can still be
    // rescued if the money turns out to have moved
    const wronglyFailed =
      rows.length > 0 &&
      rows[0].status === 'failed' &&
      Number(rows[0].result_code) === 4999 &&
      outcome.resultCode === 0;

    if (rows.length === 0 || (rows[0].status !== 'pending' && !wronglyFailed)) {
      await conn.commit();
      return rows[0] || null; // unknown, or already settled
    }
    const row = rows[0];

    let status = 'failed';
    if (outcome.resultCode === 0) status = 'success';
    else if (outcome.resultCode === 1032) status = 'cancelled';

    // Safaricom is the source of truth for the amount. A mismatch should never happen,
    // but if it does we keep the payment and flag it for manual review instead of guessing.
    let fulfilError = null;
    if (
      status === 'success' &&
      outcome.amount !== null &&
      Math.round(outcome.amount) !== Math.round(Number(row.amount))
    ) {
      fulfilError = `Amount mismatch: asked for KES ${row.amount}, received KES ${outcome.amount}. Needs manual review.`;
    }

    await conn.query(
      `UPDATE mpesa_transactions
       SET status = ?, result_code = ?, result_desc = ?, mpesa_receipt = ?, fulfil_error = ?
       WHERE id = ?`,
      [
        status,
        outcome.resultCode,
        String(outcome.resultDesc || '').slice(0, 255),
        outcome.receipt || null,
        fulfilError,
        row.id
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

// Step 2: for a successful payment, create the contribution / saving / repayment, exactly once.
// The row is locked, so the callback and the status check can't both do it.
async function fulfilIfNeeded(paymentId) {
  const conn = await db.getConnection();
  let result = null;
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM mpesa_transactions WHERE id = ? FOR UPDATE', [paymentId]);
    const row = rows[0];
    if (
      !row ||
      row.status !== 'success' ||
      row.fulfilled ||
      (row.fulfil_error || '').startsWith('Amount mismatch')
    ) {
      await conn.commit();
      return null;
    }

    const amount = parseFloat(row.amount);
    let details;

    if (row.purpose === 'contribution') {
      details = await recordContribution(conn, { groupId: row.group_id, userId: row.user_id, paying: amount });
    } else if (row.purpose === 'savings') {
      details = await recordSavings(conn, { groupId: row.group_id, userId: row.user_id, amount, note: row.note });
    } else {
      details = await applyRepayment(conn, {
        loanId: row.reference_id,
        amount,
        overflowToSavings: true,
        overflowNote: `Overpayment from loan repayment (M-Pesa ${row.mpesa_receipt || 'ref ' + row.id})`
      });
    }

    await conn.query('UPDATE mpesa_transactions SET fulfilled = 1, fulfil_error = NULL WHERE id = ?', [paymentId]);
    await conn.commit();
    result = { row, details };
  } catch (err) {
    await conn.rollback();
    console.log(`M-Pesa fulfilment failed for payment ${paymentId}:`, err.message);
    try {
      await db.query('UPDATE mpesa_transactions SET fulfil_error = ? WHERE id = ?', [
        String(err.message).slice(0, 255),
        paymentId
      ]);
    } catch (_) {
      /* nothing more we can do */
    }
    return null;
  } finally {
    conn.release();
  }

  // The payment is committed. Everything below is best-effort and must never undo it.
  await announce(result.row, result.details);
  return result;
}

async function announce(row, d) {
  const amt = parseFloat(row.amount);
  let actionType;
  let description;
  let recordedAs;

  try {
    if (row.purpose === 'contribution') {
      actionType = 'logged_contribution';
      description =
        d.remaining > 0
          ? `You paid KES ${amt} toward ${d.cyclePeriod} via M-Pesa (KES ${d.remaining} still remaining)`
          : `You completed your KES ${d.target} contribution for ${d.cyclePeriod} via M-Pesa`;
      recordedAs = 'your contribution';
    } else if (row.purpose === 'savings') {
      actionType = 'logged_savings';
      description = row.note
        ? `You saved an extra KES ${amt} via M-Pesa — ${row.note}`
        : `You saved an extra KES ${amt} via M-Pesa`;
      recordedAs = 'your extra savings';
    } else {
      actionType = 'loan_repayment';
      if (d.applied <= 0) {
        description = `Your loan was already cleared, so your KES ${amt} M-Pesa payment went to your extra savings`;
      } else if (d.loanRepaid) {
        description = `You repaid KES ${d.applied} via M-Pesa and cleared your loan`;
      } else {
        description = `You repaid KES ${d.applied} on your loan via M-Pesa, KES ${d.remaining} left`;
      }
      if (d.surplus > 0 && d.applied > 0) {
        description += `. The extra KES ${d.surplus} went to your savings`;
      }
      recordedAs = 'your loan repayment';
    }

    await logActivity({
      userId: row.user_id,
      groupId: row.group_id,
      actionType,
      description,
      amount: amt
    });

    await createNotification(
      row.user_id,
      'M-Pesa Payment Received',
      `Your M-Pesa payment of KES ${amt}${row.mpesa_receipt ? ` (${row.mpesa_receipt})` : ''} was received and recorded as ${recordedAs}.`
    );
  } catch (err) {
    console.log('M-Pesa post-payment notices failed:', err.message);
  }
}

async function settle(checkoutRequestId, outcome) {
  const row = await recordOutcome(checkoutRequestId, outcome);
  if (row) await fulfilIfNeeded(row.id);
}

// ---------- routes ----------

// POST /api/mpesa/pay
// body: { purpose, amount, group_id?, loan_id?, phone?, note? }
exports.pay = async (req, res) => {
  let paymentId = null;
  try {
    const userId = Number(req.user.userId);
    const { purpose, amount, phone, note } = req.body;
    let groupId = req.body.group_id;
    const loanId = req.body.loan_id;

    if (!PURPOSES.includes(purpose)) {
      return res.status(400).json({ success: false, message: 'purpose must be contribution, savings or loan_repayment' });
    }

    const wholeAmount = Number(amount);
    if (!Number.isInteger(wholeAmount) || wholeAmount < 1) {
      return res.status(400).json({ success: false, message: 'M-Pesa payments must be a whole number of shillings (at least KES 1)' });
    }
    if (wholeAmount > MAX_AMOUNT) {
      return res.status(400).json({ success: false, message: `The most you can send in one M-Pesa payment is KES ${MAX_AMOUNT}` });
    }

    // Phone that receives the PIN prompt: the one typed in, otherwise the one on the account
    let payerPhone;
    if (phone) {
      payerPhone = normalizePhone(phone);
    } else {
      const [u] = await db.query('SELECT phone FROM users WHERE id = ?', [userId]);
      payerPhone = normalizePhone(u[0] && u[0].phone);
    }
    if (!payerPhone) {
      return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number, e.g. 0712345678' });
    }

    let referenceId = null;

    if (purpose === 'loan_repayment') {
      if (!loanId) {
        return res.status(400).json({ success: false, message: 'loan_id is required for a loan repayment' });
      }
      const [loanRows] = await db.query('SELECT id, group_id, user_id, status FROM loans WHERE id = ?', [loanId]);
      if (loanRows.length === 0) {
        return res.status(404).json({ success: false, message: 'Loan not found' });
      }
      const loan = loanRows[0];
      if (Number(loan.user_id) !== userId) {
        return res.status(403).json({ success: false, message: 'You can only repay your own loan with M-Pesa. Ask the treasurer to record payments for others.' });
      }
      if (loan.status !== 'approved') {
        return res.status(409).json({ success: false, message: 'Only an approved, unpaid loan can be repaid' });
      }

      groupId = loan.group_id;
      referenceId = loan.id;

      // Bring interest up to date, then cap at the balance rounded UP to the next whole shilling.
      // Any extra cents from that rounding go to the member's Extra Savings when the payment is recorded.
      await accrueLoanInterest({ loanId: loan.id });
      const b = await loanBalances(db, loan.id);
      const cap = Math.ceil(b.totalOutstanding - 1e-9);
      if (cap < 1) {
        return res.status(409).json({ success: false, message: 'This loan has nothing left to pay' });
      }
      if (wholeAmount > cap) {
        return res.status(400).json({ success: false, message: `The most you can pay is KES ${cap}` });
      }
    } else if (!groupId) {
      return res.status(400).json({ success: false, message: 'group_id is required' });
    }

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    // Stop double-taps from sending two PIN prompts for the same payment
    const [pending] = await db.query(
      `SELECT id FROM mpesa_transactions
       WHERE user_id = ? AND purpose = ? AND group_id = ? AND reference_id <=> ?
         AND status = 'pending' AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
       LIMIT 1`,
      [userId, purpose, groupId, referenceId]
    );
    if (pending.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'You already have a payment waiting for your PIN. Finish it or wait a minute before trying again.',
        paymentId: pending[0].id
      });
    }

    const [ins] = await db.query(
      `INSERT INTO mpesa_transactions (user_id, group_id, purpose, reference_id, amount, phone, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, groupId, purpose, referenceId, wholeAmount, payerPhone, purpose === 'savings' ? (note || null) : null]
    );
    paymentId = ins.insertId;
    payStartedAt.set(paymentId, Date.now());

    let push;
    try {
      push = await stkPush({
        phone: payerPhone,
        amount: wholeAmount,
        accountReference: `CHAMA${groupId}`,
        description: PURPOSE_LABEL[purpose]
      });
    } catch (pushErr) {
      await db.query("UPDATE mpesa_transactions SET status = 'failed', result_desc = ? WHERE id = ?", [
        String(pushErr.message).slice(0, 255),
        paymentId
      ]);
      return res.status(502).json({ success: false, message: `Could not start the M-Pesa payment: ${pushErr.message}` });
    }

    await db.query(
      'UPDATE mpesa_transactions SET merchant_request_id = ?, checkout_request_id = ? WHERE id = ?',
      [push.MerchantRequestID, push.CheckoutRequestID, paymentId]
    );

    res.status(202).json({
      success: true,
      message: 'Check your phone and enter your M-Pesa PIN',
      paymentId
    });
  } catch (err) {
    console.log('M-Pesa pay failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/mpesa/callback/:secret   (called by Safaricom, so no login token)
// The secret in the URL is how we know the call is really from the URL we gave Daraja.
exports.callback = async (req, res) => {
  const expected = process.env.MPESA_CALLBACK_SECRET;
  if (!expected || !safeEqual(req.params.secret, expected)) {
    console.log('M-Pesa callback rejected: the secret in the URL does not match MPESA_CALLBACK_SECRET');
    return res.status(403).json({ ResultCode: 1, ResultDesc: 'Rejected' });
  }

  try {
    const outcome = parseCallback(req.body);
    if (outcome) {
      console.log(`M-Pesa callback received: ${outcome.checkoutRequestId} (result ${outcome.resultCode})`);
      await settle(outcome.checkoutRequestId, outcome);
    }
  } catch (err) {
    // Still answer 200: Safaricom won't retry usefully, and the status check can recover this payment.
    console.log('M-Pesa callback error:', err.message);
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
};

// GET /api/mpesa/status/:paymentId   (the app polls this)
exports.status = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { paymentId } = req.params;

    const load = async () => {
      const [rows] = await db.query('SELECT * FROM mpesa_transactions WHERE id = ? AND user_id = ?', [paymentId, userId]);
      return rows[0] || null;
    };

    let row = await load();
    if (!row) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const couldBeWronglyFailed = row.status === 'failed' && Number(row.result_code) === 4999;
    if ((row.status === 'pending' || couldBeWronglyFailed) && row.checkout_request_id) {
      // Fallback for a missing callback: ask Daraja directly (rate-limited)
      if (shouldQuery(row.id)) {
        try {
          const q = await stkQuery(row.checkout_request_id);
          if (!q.pending) {
            await settle(row.checkout_request_id, {
              resultCode: q.resultCode,
              resultDesc: q.resultDesc,
              receipt: null, // the query endpoint doesn't return the receipt number; only the callback does
              amount: null
            });
          }
        } catch (qErr) {
          console.log('M-Pesa status query failed:', qErr.message);
        }
      }
    } else if (row.status === 'success' && !row.fulfilled) {
      await fulfilIfNeeded(row.id); // retry a recording that failed earlier
    }

    row = await load();
    res.json({ success: true, payment: toClient(row) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};