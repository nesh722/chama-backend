const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');
const { notifyOverdueLoans, formatDate } = require('../utils/overdueLoans');
const { runOnce, RequestError, validKey } = require('../utils/idempotency');

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
      );
    } catch (notifyErr) {
      console.log('Loan decision notification failed:', notifyErr.message);
    }

    res.json({ success: true, message: `Loan ${decision} successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// RECORD A REPAYMENT
exports.recordRepayment = async (req, res) => {
  try {
    const { loanId } = req.params;
    const { amount_paid, idempotency_key } = req.body;
    const userId = req.user.userId;
    const paying = Math.round(parseFloat(amount_paid) * 100) / 100;

    if (!paying || paying <= 0) {
      return res.status(400).json({ success: false, message: 'A positive amount_paid is required' });
    }
    if (!validKey(idempotency_key)) {
      return res.status(400).json({ success: false, message: 'Invalid idempotency_key' });
    }

    const [loanRows] = await db.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    if (loanRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];

    // Only the borrower or treasurer/chair can record a repayment
    const role = await getMembership(loan.group_id, userId);
    if (userId !== loan.user_id && role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Not authorized to record this repayment' });
    }

    // The loan's status is checked inside the transaction, after the idempotency check,
    // so a retry of a repayment that completed the loan is answered as a duplicate, not an error
    const { replayed, payload } = await runOnce(
      { key: idempotency_key, userId, endpoint: 'record_repayment' },
      async (conn) => {
        const [locked] = await conn.query('SELECT amount, status FROM loans WHERE id = ? FOR UPDATE', [loanId]);
        if (locked[0].status !== 'approved') {
          throw new RequestError(409, 'Only an approved, unpaid loan can receive repayments');
        }

        const [sumRows] = await conn.query(
          'SELECT COALESCE(SUM(amount_paid), 0) AS total FROM loan_repayments WHERE loan_id = ?',
          [loanId]
        );
        const loanAmount = parseFloat(locked[0].amount);
        const alreadyRepaid = parseFloat(sumRows[0].total);
        const outstanding = Math.round((loanAmount - alreadyRepaid) * 100) / 100;

        if (paying > outstanding) {
          throw new RequestError(400, `That is more than the outstanding balance of KES ${outstanding}`);
        }

        await conn.query('INSERT INTO loan_repayments (loan_id, amount_paid) VALUES (?, ?)', [loanId, paying]);
        await conn.query(
          'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
          [loan.group_id, loan.user_id, 'loan_repayment', paying, loanId]
        );

        const remaining = Math.round((outstanding - paying) * 100) / 100;
        const loanRepaid = remaining === 0;
        if (loanRepaid) {
          await conn.query('UPDATE loans SET status = ? WHERE id = ?', ['repaid', loanId]);
        }

        return {
          success: true,
          message: 'Repayment recorded',
          totalPaid: alreadyRepaid + paying,
          loanAmount,
          remaining,
          loanRepaid
        };
      }
    );

    if (replayed) return res.status(200).json({ ...payload, duplicate: true });

    try {
      await logActivity({
        userId: loan.user_id,
        groupId: loan.group_id,
        actionType: 'loan_repayment',
        description: payload.loanRepaid
          ? `You repaid KES ${paying} and cleared your loan`
          : `You repaid KES ${paying} on your loan (KES ${payload.remaining} left)`,
        amount: paying
      });
    } catch (logErr) {
      console.log('Activity log failed:', logErr.message);
    }

    res.status(201).json(payload);
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
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

    // Opportunistic check: if the viewer has any overdue loans of their own, notify now
    await notifyOverdueLoans(userId);

    const isApprover = role === 'treasurer' || role === 'chair';

    const [rows] = await db.query(
      `SELECT l.id, l.user_id, u.full_name, l.amount, l.status, l.due_date, l.requested_at, l.approved_at,
        COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS totalRepaid
       FROM loans l
       JOIN users u ON l.user_id = u.id
       WHERE l.group_id = ? ${isApprover ? '' : 'AND l.user_id = ?'}
       ORDER BY l.requested_at DESC`,
      isApprover ? [groupId] : [groupId, userId]
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

    await notifyOverdueLoans(userId);

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
