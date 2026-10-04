const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');

// Helper: check membership + role
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// Helper: check the user's own approved loans for ones that are now overdue and
// haven't been notified yet, and notify them. Called opportunistically whenever
// loan data is fetched -- no separate scheduler/cron job needed.
async function checkAndNotifyOverdueLoans(userId) {
  const [overdue] = await db.query(
    `SELECT id, amount, due_date FROM loans
     WHERE user_id = ? AND status = 'approved' AND due_date IS NOT NULL
     AND due_date < CURDATE() AND overdue_notified = FALSE`,
    [userId]
  );

  for (const loan of overdue) {
    const dueDateLabel = new Date(loan.due_date).toISOString().split('T')[0];
    await createNotification(
      userId,
      'Loan Repayment Overdue',
      `Your loan of KES ${loan.amount} was due on ${dueDateLabel} and is now overdue. Please repay as soon as possible.`
    );
    await db.query('UPDATE loans SET overdue_notified = TRUE WHERE id = ?', [loan.id]);
  }
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

    const [result] = await db.query(
      'INSERT INTO loans (group_id, user_id, amount, status, due_date) VALUES (?, ?, ?, ?, ?)',
      [group_id, userId, amount, 'requested', due_date]
    );

    await logActivity({
      userId,
      groupId: group_id,
      actionType: 'requested_loan',
      description: `You requested a loan of KES ${amount}, due ${due_date}`,
      amount
    });

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

    res.json({ success: true, message: `Loan ${decision} successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// RECORD A REPAYMENT
exports.recordRepayment = async (req, res) => {
  try {
    const { loanId } = req.params;
    const { amount_paid } = req.body;
    const userId = req.user.userId;

    if (!amount_paid) {
      return res.status(400).json({ success: false, message: 'amount_paid is required' });
    }

    const [loanRows] = await db.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    if (loanRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];

    if (loan.status !== 'approved' && loan.status !== 'repaid') {
      return res.status(409).json({ success: false, message: 'Loan must be approved before recording repayments' });
    }

    // Only the borrower or treasurer/chair can record a repayment
    const role = await getMembership(loan.group_id, userId);
    if (userId !== loan.user_id && role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Not authorized to record this repayment' });
    }

    await db.query(
      'INSERT INTO loan_repayments (loan_id, amount_paid) VALUES (?, ?)',
      [loanId, amount_paid]
    );

    await db.query(
      'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
      [loan.group_id, loan.user_id, 'loan_repayment', amount_paid, loanId]
    );

    await logActivity({
      userId: loan.user_id,
      groupId: loan.group_id,
      actionType: 'loan_repayment',
      description: `You repaid KES ${amount_paid} on your loan`,
      amount: amount_paid
    });

    // Check if total repayments now cover the loan amount -> mark as repaid
    const [totalRows] = await db.query(
      'SELECT SUM(amount_paid) AS total FROM loan_repayments WHERE loan_id = ?',
      [loanId]
    );
    const totalPaid = parseFloat(totalRows[0].total) || 0;

    if (totalPaid >= parseFloat(loan.amount) && loan.status !== 'repaid') {
      await db.query('UPDATE loans SET status = ? WHERE id = ?', ['repaid', loanId]);
    }

    res.status(201).json({ success: true, message: 'Repayment recorded', totalPaid, loanAmount: loan.amount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET ALL LOANS FOR A GROUP
exports.getGroupLoans = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    // Opportunistic check: if the viewer has any overdue loans of their own, notify now
    await checkAndNotifyOverdueLoans(userId);

    const [rows] = await db.query(
      `SELECT l.id, l.user_id, u.full_name, l.amount, l.status, l.due_date, l.requested_at, l.approved_at,
        COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS totalRepaid
 FROM loans l
 JOIN users u ON l.user_id = u.id
 WHERE l.group_id = ?
 ORDER BY l.requested_at DESC`,
      [groupId]
    );

    res.json({ success: true, loans: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET MY LOANS (across all groups)
exports.getMyLoans = async (req, res) => {
  try {
    const userId = req.user.userId;

    await checkAndNotifyOverdueLoans(userId);

    const [rows] = await db.query(
      `SELECT l.id, g.name AS group_name, l.amount, l.status, l.due_date, l.requested_at, l.approved_at
       FROM loans l
       JOIN groups_table g ON l.group_id = g.id
       WHERE l.user_id = ?
       ORDER BY l.requested_at DESC`,
      [userId]
    );

    res.json({ success: true, loans: rows });
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
