const db = require('../config/db');
const { createNotification } = require('../controllers/notificationController');

const round2 = (n) => Math.round(n * 100) / 100;
const MAX_PERIODS = 120; // safety limit

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

function addDays(date, days) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Same day of the month, N months later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb)
function addMonths(date, months) {
  const base = startOfDay(date);
  const d = new Date(base.getFullYear(), base.getMonth() + months, 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(base.getDate(), lastDay));
  return d;
}

const toYMD = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Start date of interest period n. Period 1 begins the day after the due date plus any grace days.
function periodStart(dueDate, graceDays, period, n) {
  const first = addDays(dueDate, (parseInt(graceDays, 10) || 0) + 1);
  return period === 'weekly' ? addDays(first, 7 * (n - 1)) : addMonths(first, n - 1);
}

function periodsStarted(dueDate, graceDays, period, today = new Date()) {
  const t = startOfDay(today);
  let n = 0;
  while (n < MAX_PERIODS && periodStart(dueDate, graceDays, period, n + 1) <= t) n++;
  return n;
}

// Adds the balance fields the app displays to a loan row that includes
// principalPaid, interestPaid and interestCharged
function withBalances(row) {
  const principal = parseFloat(row.amount);
  const principalPaid = parseFloat(row.principalPaid || 0);
  const interestPaid = parseFloat(row.interestPaid || 0);
  const interestCharged = parseFloat(row.interestCharged || 0);
  return {
    ...row,
    principalOutstanding: round2(principal - principalPaid),
    interestCharged: round2(interestCharged),
    interestPaid: round2(interestPaid),
    interestOutstanding: round2(interestCharged - interestPaid),
    totalOutstanding: round2(principal - principalPaid + interestCharged - interestPaid)
  };
}

async function accrueOne(loanId) {
  const conn = await db.getConnection();
  let notice = null;

  try {
    await conn.beginTransaction();

    // Lock the loan so a repayment or another accrual run can't interleave with this one
    const [rows] = await conn.query('SELECT * FROM loans WHERE id = ? FOR UPDATE', [loanId]);
    const loan = rows[0];
    const rate = loan ? parseFloat(loan.interest_rate) : 0;

    if (!loan || loan.status !== 'approved' || !(rate > 0) || !loan.due_date) {
      await conn.rollback();
      return;
    }

    const started = periodsStarted(loan.due_date, loan.interest_grace_days, loan.interest_period);
    if (started === 0) {
      await conn.rollback();
      return;
    }

    const [existing] = await conn.query(
      'SELECT period_number, amount FROM loan_interest_charges WHERE loan_id = ?',
      [loanId]
    );
    const charged = new Set(existing.map((r) => r.period_number));
    let interestTotal = round2(existing.reduce((s, r) => s + parseFloat(r.amount), 0));

    const [paid] = await conn.query(
      `SELECT COALESCE(SUM(principal_portion), 0) AS principalPaid, COALESCE(SUM(amount_paid), 0) AS total
       FROM loan_repayments WHERE loan_id = ?`,
      [loanId]
    );
    const principal = parseFloat(loan.amount);
    const unpaidPrincipal = round2(principal - parseFloat(paid[0].principalPaid));
    const capAmount =
      loan.interest_cap_percent != null ? round2((principal * parseFloat(loan.interest_cap_percent)) / 100) : null;

    let added = 0;
    for (let n = 1; n <= started; n++) {
      if (charged.has(n)) continue;
      if (unpaidPrincipal <= 0) break; // principal cleared: interest stops growing

      let amount = round2((unpaidPrincipal * rate) / 100);
      if (capAmount !== null) amount = Math.min(amount, round2(capAmount - interestTotal));
      if (amount <= 0) break; // cap reached

      await conn.query(
        `INSERT INTO loan_interest_charges (loan_id, period_number, charged_on, base_amount, rate, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          loanId,
          n,
          toYMD(periodStart(loan.due_date, loan.interest_grace_days, loan.interest_period, n)),
          unpaidPrincipal,
          rate,
          amount
        ]
      );
      interestTotal = round2(interestTotal + amount);
      added = round2(added + amount);
    }

    // Only notify once the borrower has already been told the loan is overdue. The first
    // overdue alert reports the amount owed itself, so it doesn't need a second message.
    if (added > 0 && loan.overdue_notified) {
      const [g] = await conn.query('SELECT name FROM groups_table WHERE id = ?', [loan.group_id]);
      notice = {
        userId: loan.user_id,
        added,
        owed: Math.max(round2(principal + interestTotal - parseFloat(paid[0].total)), 0),
        groupName: g[0]?.name || 'your group'
      };
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (notice) {
    try {
      await createNotification(
        notice.userId,
        'Late Interest Added',
        `KES ${notice.added} late interest was added to your overdue loan in ${notice.groupName}. You now owe KES ${notice.owed}.`
      );
    } catch (err) {
      console.log('Interest notification failed:', err.message);
    }
  }
}

// Posts any interest periods that have started and haven't been charged yet.
// Safe to call as often as you like: a period can only ever be charged once.
async function accrueLoanInterest({ userId = null, groupId = null, loanId = null } = {}) {
  const params = [];
  let sql = `SELECT id FROM loans
             WHERE status = 'approved' AND interest_rate > 0
             AND due_date IS NOT NULL AND due_date < CURDATE()`;
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (groupId) { sql += ' AND group_id = ?'; params.push(groupId); }
  if (loanId) { sql += ' AND id = ?'; params.push(loanId); }

  const [candidates] = await db.query(sql, params);
  for (const c of candidates) {
    try {
      await accrueOne(c.id);
    } catch (err) {
      console.log(`Interest accrual failed for loan ${c.id}:`, err.message);
    }
  }
}

module.exports = { accrueLoanInterest, withBalances, round2 };