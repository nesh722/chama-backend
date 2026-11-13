const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');
const { notifyOverdueLoans, formatDate } = require('../utils/overdueLoans');
const { runOnce, RequestError, validKey } = require('../utils/idempotency');
const { accrueLoanInterest, withBalances, round2 } = require('../utils/loanInterest');
const { MIN_APPROVERS, countApprovers } = require('../utils/approvers');

// Helper: check membership + role
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// REQUEST A LOAN
exports.requestLoan = async (req, res) => {
  try {
    const { group_id, amount, due_date } = req.body;
    const userId = req.user.userId;

    if (!group_id || !amount || !due_date) {
      return res.status(400).json({ success: false, message: 'group_id, amount, and due_date are required' });
    }

    const parsedDueDate = new Date(due_date);
    if (isNaN(parsedDueDate.getTime()) || parsedDueDate <= new Date()) {
      return res.status(400).json({ success: false, message: 'due_date must be a valid future date' });
    }

    const role = await getMembership(group_id, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

        if ((await countApprovers(group_id)) < MIN_APPROVERS) {
      return res.status(409).json({
        success: false,
        message: `Loans are paused: this group needs at least ${MIN_APPROVERS} approvers (treasurer or chair). Ask the group's leaders to assign another.`
      });
    }

    // Block a new request while an unpaid loan already exists in this group
    const [existingUnpaid] = await db.query(
      `SELECT id FROM loans WHERE group_id = ? AND user_id = ? AND status IN ('requested', 'approved')`,
      [group_id, userId]
    );
    if (existingUnpaid.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'You must finish repaying your current loan in this group before requesting another'
      });
    }

    const [terms] = await db.query(
      `SELECT late_interest_rate, late_interest_period, late_interest_grace_days, late_interest_cap_percent
       FROM groups_table WHERE id = ?`,
      [group_id]
    );
    const t = terms[0];

    const [result] = await db.query(
      `INSERT INTO loans (group_id, user_id, amount, status, due_date,
                          interest_rate, interest_period, interest_grace_days, interest_cap_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [group_id, userId, amount, 'requested', due_date,
       t.late_interest_rate, t.late_interest_period, t.late_interest_grace_days, t.late_interest_cap_percent]
    );

    await logActivity({
      userId,
      groupId: group_id,
      actionType: 'requested_loan',
      description: `You requested a loan of KES ${amount}, due ${due_date}`,
      amount
    });

        // Tell the group's treasurer/chair there's a request waiting. Wrapped separately:
    // the loan is already saved, so a notification hiccup shouldn't fail the request.
    try {
      const [approvers] = await db.query(
        `SELECT user_id FROM group_members
         WHERE group_id = ? AND role IN ('treasurer', 'chair') AND user_id != ?`,
        [group_id, userId]
      );
      const [info] = await db.query(
        `SELECT (SELECT full_name FROM users WHERE id = ?) AS borrower_name,
                (SELECT name FROM groups_table WHERE id = ?) AS group_name`,
        [userId, group_id]
      );
      for (const a of approvers) {
        await createNotification(
          a.user_id,
          'New Loan Request',
          `${info[0].borrower_name} requested a loan of KES ${amount} in ${info[0].group_name}. Open the Loans tab to review it.`
          , group_id
        );
      }
    } catch (notifyErr) {
      console.log('Loan request notification failed:', notifyErr.message);
    }

    res.status(201).json({ success: true, message: 'Loan requested successfully', loanId: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// APPROVE OR REJECT A LOAN (treasurer or chair only)
exports.decideLoan = async (req, res) => {
  try {
    const { loanId } = req.params;
    const { decision } = req.body; // "approved" or "rejected"
    const userId = req.user.userId;

    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be "approved" or "rejected"' });
    }

    const [loanRows] = await db.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    if (loanRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];

    if (loan.status !== 'requested') {
      return res.status(409).json({ success: false, message: `Loan already ${loan.status}` });
    }

    const role = await getMembership(loan.group_id, userId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can approve/reject loans' });
    }
    if (loan.user_id === userId) {
      return res.status(403).json({ success: false, message: 'You cannot approve or reject your own loan request' });
    }
    await db.query(
      'UPDATE loans SET status = ?, approved_at = NOW(), approved_by = ? WHERE id = ?',
      [decision, userId, loanId]
    );

    // If approved, log disbursement in transactions ledger
    if (decision === 'approved') {
      await db.query(
        'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
        [loan.group_id, loan.user_id, 'loan_disbursement', loan.amount, loanId]
      );
    }

    await logActivity({
      userId: loan.user_id,
      groupId: loan.group_id,
      actionType: decision === 'approved' ? 'loan_approved' : 'loan_rejected',
      description:
        decision === 'approved'
          ? `Your loan request of KES ${loan.amount} was approved`
          : `Your loan request of KES ${loan.amount} was rejected`,
      amount: loan.amount
    });

    try {
      const [groupInfo] = await db.query('SELECT name FROM groups_table WHERE id = ?', [loan.group_id]);
      const groupName = groupInfo[0]?.name || 'your group';
      await createNotification(
        loan.user_id,
        decision === 'approved' ? 'Loan Approved' : 'Loan Rejected',
        decision === 'approved'
          ? `Your loan of KES ${loan.amount} in ${groupName} was approved. Please repay by ${loan.due_date ? formatDate(loan.due_date) : 'the agreed date'}.`
          : `Your loan request of KES ${loan.amount} in ${groupName} was rejected.`
        , loan.group_id
      );
    } catch (notifyErr) {
      console.log('Loan decision notification failed:', notifyErr.message);
    }

    res.json({ success: true, message: `Loan ${decision} successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// RECORD A REPAYMENT: switched off. A cash repayment is no longer recorded on someone's word alone.
// The borrower claims it and the treasurer / chair who received the cash confirms it (see cashClaimController.js).
// M-Pesa repayments are recorded automatically by mpesaController.js. This stub only answers old app versions clearly.
exports.recordRepayment = async (req, res) => {
  res.status(410).json({
    success: false,
    message: 'Cash repayments now need to be confirmed by the treasurer or chair who received them. Update the app and use "I paid cash".'
  });
};
// GET ALL LOANS FOR A GROUP
// GET LOANS FOR A GROUP
// Treasurer/chair see every member's loans; regular members see only their own.
exports.getGroupLoans = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    await notifyOverdueLoans(userId);
    await accrueLoanInterest({ groupId }); // bring everyone's interest up to date before showing the list

    const isApprover = role === 'treasurer' || role === 'chair';

    const [rows] = await db.query(
      `SELECT l.id, l.user_id, u.full_name, l.amount, l.status, l.due_date, l.requested_at, l.approved_at,
        l.interest_rate, l.interest_period, l.interest_grace_days, l.interest_cap_percent,
        COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS totalRepaid,
        COALESCE((SELECT SUM(principal_portion) FROM loan_repayments WHERE loan_id = l.id), 0) AS principalPaid,
        COALESCE((SELECT SUM(interest_portion) FROM loan_repayments WHERE loan_id = l.id), 0) AS interestPaid,
        COALESCE((SELECT SUM(amount) FROM loan_interest_charges WHERE loan_id = l.id), 0) AS interestCharged
       FROM loans l
       JOIN users u ON l.user_id = u.id
       WHERE l.group_id = ? ${isApprover ? '' : 'AND l.user_id = ?'}
       ORDER BY l.requested_at DESC`,
      isApprover ? [groupId] : [groupId, userId]
    );

    res.json({ success: true, loans: rows.map(withBalances) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// GET MY LOANS (across all groups)
exports.getMyLoans = async (req, res) => {
  try {
    const userId = req.user.userId;

    await notifyOverdueLoans(userId); // also posts any interest that is due

    const [rows] = await db.query(
      `SELECT l.id, l.group_id, g.name AS group_name, l.amount, l.status, l.due_date, l.requested_at, l.approved_at,
        l.interest_rate, l.interest_period, l.interest_grace_days, l.interest_cap_percent,
        COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS totalRepaid,
        COALESCE((SELECT SUM(principal_portion) FROM loan_repayments WHERE loan_id = l.id), 0) AS principalPaid,
        COALESCE((SELECT SUM(interest_portion) FROM loan_repayments WHERE loan_id = l.id), 0) AS interestPaid,
        COALESCE((SELECT SUM(amount) FROM loan_interest_charges WHERE loan_id = l.id), 0) AS interestCharged
       FROM loans l
       JOIN groups_table g ON l.group_id = g.id
       WHERE l.user_id = ?
       ORDER BY l.requested_at DESC`,
      [userId]
    );

    res.json({ success: true, loans: rows.map(withBalances) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET LOAN REQUESTS AWAITING MY DECISION (across all groups where I'm treasurer/chair)
exports.getPendingApprovals = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [rows] = await db.query(
      `SELECT l.id, l.group_id, g.name AS group_name, l.user_id, u.full_name AS borrower_name, l.amount, l.due_date, l.requested_at
       FROM loans l
       JOIN groups_table g ON l.group_id = g.id
       JOIN users u ON l.user_id = u.id
       JOIN group_members gm ON gm.group_id = l.group_id AND gm.user_id = ?
       WHERE l.status = 'requested'
       AND gm.role IN ('treasurer', 'chair')
       AND l.user_id != ?
       ORDER BY l.requested_at ASC`,
      [userId, userId]
    );

    res.json({ success: true, pending: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};