const db = require('../config/db');
const { createNotification } = require('../controllers/notificationController');
const { accrueLoanInterest } = require('./loanInterest');

const REMINDER_INTERVAL_DAYS = 3; // days between reminders
const MAX_REMINDERS = 5;          // stop after this many reminders per loan

const round2 = (n) => Math.round(n * 100) / 100;

function formatDate(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysOverdue(dueDate) {
  const due = new Date(dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.max(Math.round((today - due) / 86400000), 1);
}

function interestNote(loan, owed) {
  const rate = parseFloat(loan.interest_rate);
  if (!(rate > 0)) return ' Please repay as soon as possible.';
  const per = loan.interest_period === 'weekly' ? 'week' : 'month';
  const grace = parseInt(loan.interest_grace_days, 10) || 0;
  return ` Late interest of ${rate}% per ${per} applies${grace > 0 ? ` after ${grace} grace day${grace === 1 ? '' : 's'}` : ''}. You currently owe KES ${owed}.`;
}

// First alert: tells the borrower AND the group's treasurer/chair that a loan just went overdue.
async function announceNewlyOverdue(userId = null) {
  const params = [];
  let sql = `SELECT l.id, l.user_id, l.group_id, l.amount, l.due_date,
                    l.interest_rate, l.interest_period, l.interest_grace_days,
                    u.full_name AS borrower_name, g.name AS group_name,
                    COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS repaid,
                    COALESCE((SELECT SUM(amount) FROM loan_interest_charges WHERE loan_id = l.id), 0) AS interestCharged
             FROM loans l
             JOIN users u ON l.user_id = u.id
             JOIN groups_table g ON l.group_id = g.id
             WHERE l.status = 'approved' AND l.due_date IS NOT NULL
             AND l.due_date < CURDATE() AND l.overdue_notified = FALSE`;
  if (userId) {
    sql += ' AND l.user_id = ?';
    params.push(userId);
  }

  const [overdue] = await db.query(sql, params);

  for (const loan of overdue) {
    // Claim the loan first, so the scheduled job and an on-demand check can't both notify.
    // Also starts the reminder clock.
    const [claim] = await db.query(
      `UPDATE loans SET overdue_notified = TRUE, last_reminded_at = NOW(), reminder_count = 0
       WHERE id = ? AND overdue_notified = FALSE`,
      [loan.id]
    );
    if (claim.affectedRows === 0) continue;

    const dueLabel = formatDate(loan.due_date);
    const owed = Math.max(round2(parseFloat(loan.amount) + parseFloat(loan.interestCharged) - parseFloat(loan.repaid)), 0);

    try {
      await createNotification(
        loan.user_id,
        'Loan Repayment Overdue',
        `Your loan of KES ${loan.amount} was due on ${dueLabel} and is now overdue.${interestNote(loan, owed)}`
      );
    } catch (err) {
      await db.query(
        'UPDATE loans SET overdue_notified = FALSE, last_reminded_at = NULL WHERE id = ?',
        [loan.id]
      );
      console.log('Overdue notification failed:', err.message);
      continue;
    }

    // Approvers: their own try/catch, and no rollback, since the borrower was already told
    try {
      const [approvers] = await db.query(
        `SELECT user_id FROM group_members
         WHERE group_id = ? AND role IN ('treasurer', 'chair') AND user_id != ?`,
        [loan.group_id, loan.user_id]
      );
      for (const a of approvers) {
        await createNotification(
          a.user_id,
          'Loan Overdue',
          `${loan.borrower_name}'s loan of KES ${loan.amount} in ${loan.group_name} was due on ${dueLabel} and is now overdue.`
        );
      }
    } catch (err) {
      console.log('Overdue approver notification failed:', err.message);
    }
  }
}

// Follow-up reminders to the borrower while the loan stays unpaid.
async function sendOverdueReminders(userId = null) {
  const params = [MAX_REMINDERS, REMINDER_INTERVAL_DAYS];
  let sql = `SELECT l.id, l.user_id, l.amount, l.due_date, l.last_reminded_at, l.reminder_count,
                    g.name AS group_name,
                    COALESCE((SELECT SUM(amount_paid) FROM loan_repayments WHERE loan_id = l.id), 0) AS repaid,
                    COALESCE((SELECT SUM(amount) FROM loan_interest_charges WHERE loan_id = l.id), 0) AS interestCharged
             FROM loans l
             JOIN groups_table g ON l.group_id = g.id
             WHERE l.status = 'approved' AND l.due_date IS NOT NULL
             AND l.due_date < CURDATE() AND l.overdue_notified = TRUE
             AND l.reminder_count < ?
             AND (l.last_reminded_at IS NULL
                  OR DATE(l.last_reminded_at) <= DATE_SUB(CURDATE(), INTERVAL ? DAY))`;
  if (userId) {
    sql += ' AND l.user_id = ?';
    params.push(userId);
  }

  const [due] = await db.query(sql, params);

  for (const loan of due) {
    // Claim this reminder slot; the reminder_count check blocks double-sends
    const [claim] = await db.query(
      `UPDATE loans SET last_reminded_at = NOW(), reminder_count = reminder_count + 1
       WHERE id = ? AND reminder_count = ?`,
      [loan.id, loan.reminder_count]
    );
    if (claim.affectedRows === 0) continue;

    const interestCharged = parseFloat(loan.interestCharged);
    const owed = Math.max(round2(parseFloat(loan.amount) + interestCharged - parseFloat(loan.repaid)), 0);
    const days = daysOverdue(loan.due_date);
    const isFinal = loan.reminder_count + 1 >= MAX_REMINDERS;

    try {
      await createNotification(
        loan.user_id,
        isFinal ? 'Final Loan Reminder' : 'Loan Repayment Reminder',
        `Your loan in ${loan.group_name} is ${days} day${days === 1 ? '' : 's'} overdue. ` +
        `KES ${owed} is still outstanding${interestCharged > 0 ? ', including late interest' : ''}.` +
        (isFinal ? ' This is the final reminder.' : ' Please repay as soon as possible.')
      );
    } catch (err) {
      await db.query(
        'UPDATE loans SET last_reminded_at = ?, reminder_count = ? WHERE id = ?',
        [loan.last_reminded_at, loan.reminder_count, loan.id]
      );
      console.log('Overdue reminder failed:', err.message);
    }
  }
}

async function notifyOverdueLoans(userId = null) {
  await accrueLoanInterest({ userId }); // post any interest that is due first, so the messages below are accurate
  await announceNewlyOverdue(userId);
  await sendOverdueReminders(userId);
}

module.exports = { notifyOverdueLoans, formatDate };