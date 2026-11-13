const db = require('../config/db');
const { RequestError } = require('../utils/idempotency');
const { recordContribution, applyRepayment, loanBalances } = require('../utils/payments');
const { accrueLoanInterest, round2 } = require('../utils/loanInterest');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');

const KINDS = ['contribution', 'loan_repayment'];
const MAX_AMOUNT = 99999999;

const isApprover = (role) => role === 'treasurer' || role === 'chair';
const money = (n) => Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });

async function getMembership(groupId, userId, executor = db) {
  const [rows] = await executor.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

async function nameOf(userId) {
  if (!userId) return null;
  const [rows] = await db.query('SELECT full_name FROM users WHERE id = ?', [userId]);
  return rows[0] ? rows[0].full_name : null;
}

// The claim is already saved, so a notification hiccup must never fail the request
async function tell(userId, title, message, groupId = null){
  try {
    await createNotification(userId, title, message, groupId);
  } catch (err) {
    console.log('Cash claim notification failed:', err.message);
  }
}

async function logSafely(entry) {
  try {
    await logActivity(entry);
  } catch (err) {
    console.log('Activity log failed:', err.message);
  }
}

function sendError(res, err) {
  if (err instanceof RequestError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  return res.status(500).json({ success: false, error: err.message });
}

// POST /api/cash-claims   body: { group_id, kind, loan_id?, amount, receiver_id }
exports.create = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { group_id, kind, loan_id, amount, receiver_id } = req.body;

    if (!group_id || !KINDS.includes(kind)) {
      return res.status(400).json({ success: false, message: 'group_id and a valid kind are required' });
    }
    const paying = round2(parseFloat(amount));
    if (!(paying > 0) || paying > MAX_AMOUNT) {
      return res.status(400).json({ success: false, message: 'Enter a valid amount' });
    }

    const myRole = await getMembership(group_id, userId);
    if (!myRole) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const receiverId = Number(receiver_id);
    if (!receiverId) {
      return res.status(400).json({ success: false, message: 'Choose the treasurer or chair you handed the money to' });
    }
    if (receiverId === userId) {
      return res.status(400).json({ success: false, message: 'You cannot confirm your own payment. Choose another treasurer or chair.' });
    }
    if (!isApprover(await getMembership(group_id, receiverId))) {
      return res.status(400).json({ success: false, message: 'That person is not a treasurer or chair of this group' });
    }

    let loanId = null;
    if (kind === 'loan_repayment') {
      if (!loan_id) {
        return res.status(400).json({ success: false, message: 'loan_id is required for a loan repayment' });
      }
      const [loanRows] = await db.query('SELECT id, group_id, user_id, status FROM loans WHERE id = ?', [loan_id]);
      if (loanRows.length === 0) {
        return res.status(404).json({ success: false, message: 'Loan not found' });
      }
      const loan = loanRows[0];
      if (Number(loan.group_id) !== Number(group_id) || Number(loan.user_id) !== userId) {
        return res.status(403).json({ success: false, message: 'You can only claim repayments on your own loan' });
      }
      if (loan.status !== 'approved') {
        return res.status(409).json({ success: false, message: 'Only an approved, unpaid loan can receive repayments' });
      }
      loanId = loan.id;

      // Bring interest up to date so the balance we compare against is real
      await accrueLoanInterest({ loanId });
      const b = await loanBalances(db, loanId);
      if (paying > b.totalOutstanding) {
        return res.status(400).json({ success: false, message: `That is more than the outstanding balance of KES ${b.totalOutstanding}` });
      }
    }

    const conn = await db.getConnection();
    let claimId;
    try {
      await conn.beginTransaction();

      // Serialise this member's claims so a double tap can't leave two open claims
      await conn.query('SELECT id FROM group_members WHERE group_id = ? AND user_id = ? FOR UPDATE', [group_id, userId]);

      const [open] = await conn.query(
        loanId
          ? `SELECT id FROM cash_claims WHERE group_id = ? AND user_id = ? AND kind = ? AND loan_id = ? AND status = 'pending' LIMIT 1`
          : `SELECT id FROM cash_claims WHERE group_id = ? AND user_id = ? AND kind = ? AND loan_id IS NULL AND status = 'pending' LIMIT 1`,
        loanId ? [group_id, userId, kind, loanId] : [group_id, userId, kind]
      );
      if (open.length > 0) {
        throw new RequestError(409, 'You already have a cash payment waiting for confirmation. Cancel it first if the amount was wrong.');
      }

      const [ins] = await conn.query(
        'INSERT INTO cash_claims (group_id, user_id, kind, loan_id, claimed_amount, receiver_id) VALUES (?, ?, ?, ?, ?, ?)',
        [group_id, userId, kind, loanId, paying, receiverId]
      );
      claimId = ins.insertId;
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const payerName = (await nameOf(userId)) || 'A member';
    await tell(
      receiverId,
      'Cash Payment To Confirm',
      `${payerName} says they handed you KES ${money(paying)} in cash ${kind === 'loan_repayment' ? 'for their loan' : 'for their contribution'}. Open the group to confirm what you received.`
        ,group_id
    );

    res.status(201).json({ success: true, message: 'Sent for confirmation', claimId });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/cash-claims/group/:groupId
// Your own claims, plus the ones other members say they handed to YOU.
exports.listForGroup = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { groupId } = req.params;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT c.id, c.kind, c.loan_id, c.user_id, c.receiver_id, c.claimed_amount, c.confirmed_amount, c.status,
              c.reject_reason, c.dismissed_by_payer, c.created_at, c.decided_at,
              p.full_name AS payer_name, r.full_name AS receiver_name
       FROM cash_claims c
       JOIN users p ON p.id = c.user_id
       JOIN users r ON r.id = c.receiver_id
       WHERE c.group_id = ? AND (c.user_id = ? OR c.receiver_id = ?)
       ORDER BY (c.status = 'pending') DESC, c.id DESC
       LIMIT 100`,
      [groupId, userId, userId]
    );

    const claims = rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      loanId: c.loan_id,
      payerId: c.user_id,
      payerName: c.payer_name,
      receiverId: c.receiver_id,
      receiverName: c.receiver_name,
      claimedAmount: Number(c.claimed_amount),
      confirmedAmount: c.confirmed_amount === null ? null : Number(c.confirmed_amount),
      status: c.status,
      rejectReason: c.reject_reason,
      dismissed: !!c.dismissed_by_payer,
      createdAt: c.created_at,
      decidedAt: c.decided_at,
      canConfirm: c.status === 'pending' && Number(c.receiver_id) === userId && isApprover(role),
      canCancel: c.status === 'pending' && Number(c.user_id) === userId
    }));

    res.json({ success: true, claims });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/cash-claims/pending
// Every cash payment, in any of your groups, that a member says they handed to YOU and is still waiting (for the Home screen).
exports.listPending = async (req, res) => {
  try {
    const userId = Number(req.user.userId);

    const [rows] = await db.query(
      `SELECT c.id, c.group_id, g.name AS group_name, c.kind, c.loan_id, c.user_id, p.full_name AS payer_name,
              c.claimed_amount, c.created_at
       FROM cash_claims c
       JOIN groups_table g ON g.id = c.group_id
       JOIN users p ON p.id = c.user_id
       JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = ?
       WHERE c.receiver_id = ? AND c.status = 'pending' AND gm.role IN ('treasurer', 'chair')
       ORDER BY c.created_at ASC`,
      [userId, userId]
    );

    res.json({
      success: true,
      pending: rows.map((c) => ({
        id: c.id,
        groupId: c.group_id,
        groupName: c.group_name,
        kind: c.kind,
        loanId: c.loan_id,
        payerId: c.user_id,
        payerName: c.payer_name,
        claimedAmount: Number(c.claimed_amount),
        createdAt: c.created_at
      }))
    });
  } catch (err) {
    sendError(res, err);
  }
};

// Shared start of confirm / reject: lock the claim and check it is still pending and addressed to this user
async function lockPendingClaimFor(conn, claimId, userId) {
  const [rows] = await conn.query('SELECT * FROM cash_claims WHERE id = ? FOR UPDATE', [claimId]);
  if (rows.length === 0) throw new RequestError(404, 'Cash payment not found');
  const claim = rows[0];

  if (claim.status !== 'pending') {
    throw new RequestError(409, `This payment is already ${claim.status}`);
  }
  if (Number(claim.receiver_id) !== userId) {
    throw new RequestError(403, 'Only the treasurer or chair this payment was handed to can confirm it');
  }
  if (Number(claim.user_id) === userId) {
    throw new RequestError(403, 'You cannot confirm your own payment');
  }
  if (!isApprover(await getMembership(claim.group_id, userId, conn))) {
    throw new RequestError(403, 'Only a treasurer or chair can confirm cash payments');
  }
  return claim;
}

// POST /api/cash-claims/:id/confirm   body: { amount? }   amount = what you actually received (default: what they claimed)
exports.confirm = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { id } = req.params;

    const [pre] = await db.query('SELECT kind, loan_id, status FROM cash_claims WHERE id = ?', [id]);
    if (pre.length === 0) {
      return res.status(404).json({ success: false, message: 'Cash payment not found' });
    }
    if (pre[0].kind === 'loan_repayment' && pre[0].status === 'pending') {
      await accrueLoanInterest({ loanId: pre[0].loan_id }); // post any interest due before taking the payment
    }

    const conn = await db.getConnection();
    let claim;
    let confirmed;
    let result;
    try {
      await conn.beginTransaction();
      claim = await lockPendingClaimFor(conn, id, userId);

      if (!(await getMembership(claim.group_id, claim.user_id, conn))) {
        throw new RequestError(409, 'That member is no longer in this group. Reject this payment instead.');
      }

      const claimed = round2(parseFloat(claim.claimed_amount));
      confirmed = req.body.amount === undefined || req.body.amount === null || req.body.amount === ''
        ? claimed
        : round2(parseFloat(req.body.amount));
      if (!(confirmed > 0) || confirmed > claimed) {
        throw new RequestError(400, `Enter the amount you received, between 0.01 and ${claimed}`);
      }

      if (claim.kind === 'contribution') {
        result = await recordContribution(conn, { groupId: claim.group_id, userId: claim.user_id, paying: confirmed });
      } else {
        result = await applyRepayment(conn, { loanId: claim.loan_id, amount: confirmed });
      }

      await conn.query(
        `UPDATE cash_claims SET status = 'confirmed', confirmed_amount = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
        [confirmed, userId, claim.id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // The payment is committed. Everything below is best-effort and must never undo it.
    const receiverName = (await nameOf(userId)) || 'the treasurer';
    const adjusted = confirmed !== round2(parseFloat(claim.claimed_amount));
    const adjustedNote = adjusted ? ` (you said KES ${money(claim.claimed_amount)}, they confirmed KES ${money(confirmed)})` : '';

    if (claim.kind === 'contribution') {
      await logSafely({
        userId: claim.user_id,
        groupId: claim.group_id,
        actionType: 'logged_contribution',
        description: result.remaining > 0
          ? `You paid KES ${money(confirmed)} in cash toward ${result.cyclePeriod}, confirmed by ${receiverName} (KES ${money(result.remaining)} still remaining)`
          : `You completed your KES ${money(result.target)} contribution for ${result.cyclePeriod}, confirmed by ${receiverName}`,
        amount: confirmed
      });
      await tell(
        claim.user_id,
        'Cash Payment Confirmed',
        `${receiverName} confirmed your cash contribution of KES ${money(confirmed)}${adjustedNote}.`
        ,claim.group_id
      );
    } else {
      await logSafely({
        userId: claim.user_id,
        groupId: claim.group_id,
        actionType: 'loan_repayment',
        description: result.loanRepaid
          ? `You repaid KES ${money(confirmed)} in cash and cleared your loan, confirmed by ${receiverName}`
          : `You repaid KES ${money(confirmed)} in cash on your loan, confirmed by ${receiverName}. KES ${money(result.remaining)} left`,
        amount: confirmed
      });
      await tell(
        claim.user_id,
        'Cash Payment Confirmed',
        `${receiverName} confirmed your cash loan repayment of KES ${money(confirmed)}${adjustedNote}.${result.loanRepaid ? ' Your loan is fully repaid.' : ''}`
        ,claim.group_id
      );
    }

    res.json({ success: true, message: 'Confirmed and recorded', confirmedAmount: confirmed, ...result });
  } catch (err) {
    sendError(res, err);
  }
};

// POST /api/cash-claims/:id/reject   body: { reason? }
exports.reject = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { id } = req.params;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 255) : '';

    const conn = await db.getConnection();
    let claim;
    try {
      await conn.beginTransaction();
      claim = await lockPendingClaimFor(conn, id, userId);
      await conn.query(
        `UPDATE cash_claims SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
        [reason || null, userId, claim.id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const receiverName = (await nameOf(userId)) || 'The treasurer';
    await tell(
      claim.user_id,
      'Cash Payment Not Confirmed',
      `${receiverName} did not confirm your cash payment of KES ${money(claim.claimed_amount)}.${reason ? ` Reason: “${reason}”.` : ''} Nothing was recorded.`
      ,claim.group_id
    );

    res.json({ success: true, message: 'Rejected. Nothing was recorded.' });
  } catch (err) {
    sendError(res, err);
  }
};

// POST /api/cash-claims/:id/dismiss   (the payer hides a confirmed / rejected answer from their screen; it stays on record)
exports.dismiss = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { id } = req.params;

    const [rows] = await db.query('SELECT user_id, status FROM cash_claims WHERE id = ?', [id]);
    if (rows.length === 0) throw new RequestError(404, 'Cash payment not found');
    if (Number(rows[0].user_id) !== userId) throw new RequestError(403, 'Only the member who made this claim can dismiss it');
    if (rows[0].status !== 'confirmed' && rows[0].status !== 'rejected') {
      throw new RequestError(409, 'Only a payment that has been answered can be dismissed');
    }

    await db.query('UPDATE cash_claims SET dismissed_by_payer = 1 WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
};

// POST /api/cash-claims/:id/cancel   (the member who made the claim, while it is still pending)
exports.cancel = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { id } = req.params;

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM cash_claims WHERE id = ? FOR UPDATE', [id]);
      if (rows.length === 0) throw new RequestError(404, 'Cash payment not found');
      if (Number(rows[0].user_id) !== userId) throw new RequestError(403, 'Only the member who made this claim can cancel it');
      if (rows[0].status !== 'pending') throw new RequestError(409, `This payment is already ${rows[0].status}`);
      await conn.query(`UPDATE cash_claims SET status = 'cancelled', decided_at = NOW() WHERE id = ?`, [rows[0].id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: 'Cancelled' });
  } catch (err) {
    sendError(res, err);
  }
};