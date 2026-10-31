const { RequestError } = require('./idempotency');
const { getCurrentCycleLabel } = require('./cycle');
const { round2 } = require('./loanInterest');

// Adds a payment to the member's contribution for the group's CURRENT cycle.
async function recordContribution(conn, { groupId, userId, paying }) {
  const [groupRows] = await conn.query(
    'SELECT contribution_amount, contribution_frequency, cycle_anchor_date FROM groups_table WHERE id = ?',
    [groupId]
  );
  if (groupRows.length === 0) throw new RequestError(404, 'Group not found');

  const group = groupRows[0];
  const cyclePeriod = getCurrentCycleLabel(group.contribution_frequency, group.cycle_anchor_date);
  const target = parseFloat(group.contribution_amount);

  const [existing] = await conn.query(
    'SELECT id, amount FROM contributions WHERE group_id = ? AND user_id = ? AND cycle_period = ? FOR UPDATE',
    [groupId, userId, cyclePeriod]
  );

  const alreadyPaid = existing.length > 0 ? parseFloat(existing[0].amount) : 0;
  const newTotal = round2(alreadyPaid + paying);
  const status = newTotal >= target ? 'paid' : 'partial';
  const remaining = Math.max(round2(target - newTotal), 0);

  let contributionId;
  if (existing.length > 0) {
    contributionId = existing[0].id;
    await conn.query(
      'UPDATE contributions SET amount = ?, status = ?, paid_at = NOW() WHERE id = ?',
      [newTotal, status, contributionId]
    );
  } else {
    const [result] = await conn.query(
      'INSERT INTO contributions (group_id, user_id, amount, cycle_period, status, paid_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [groupId, userId, newTotal, cyclePeriod, status]
    );
    contributionId = result.insertId;
  }

  await conn.query(
    'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
    [groupId, userId, 'contribution', paying, contributionId]
  );

  return { contributionId, cyclePeriod, status, paidSoFar: newTotal, remaining, target };
}

// Adds a voluntary Extra Savings deposit.
async function recordSavings(conn, { groupId, userId, amount, note }) {
  const [result] = await conn.query(
    'INSERT INTO savings_deposits (group_id, user_id, amount, note) VALUES (?, ?, ?, ?)',
    [groupId, userId, amount, note || null]
  );
  await conn.query(
    'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
    [groupId, userId, 'savings', amount, result.insertId]
  );
  return { depositId: result.insertId };
}

// What a loan still owes: interest first, then principal.
// `executor` is either the pool (db) or an open connection.
async function loanBalances(executor, loanId, { forUpdate = false } = {}) {
  const [loanRows] = await executor.query(
    `SELECT id, group_id, user_id, amount, status FROM loans WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [loanId]
  );
  if (loanRows.length === 0) throw new RequestError(404, 'Loan not found');
  const loan = loanRows[0];

  const [sums] = await executor.query(
    `SELECT
       COALESCE((SELECT SUM(principal_portion) FROM loan_repayments WHERE loan_id = ?), 0) AS principalPaid,
       COALESCE((SELECT SUM(interest_portion) FROM loan_repayments WHERE loan_id = ?), 0) AS interestPaid,
       COALESCE((SELECT SUM(amount) FROM loan_interest_charges WHERE loan_id = ?), 0) AS interestCharged`,
    [loanId, loanId, loanId]
  );

  const principalOutstanding = round2(parseFloat(loan.amount) - parseFloat(sums[0].principalPaid));
  const interestOutstanding = Math.max(
    round2(parseFloat(sums[0].interestCharged) - parseFloat(sums[0].interestPaid)),
    0
  );
  const totalOutstanding = round2(principalOutstanding + interestOutstanding);

  return { loan, principalOutstanding, interestOutstanding, totalOutstanding };
}

// Applies a repayment to a loan (interest first, then principal).
//
// overflowToSavings = false  -> manual behaviour: paying more than is owed is an error.
// overflowToSavings = true   -> M-Pesa behaviour: the money has already moved, so whatever the
//                               loan doesn't need goes into the member's Extra Savings instead.
async function applyRepayment(conn, { loanId, amount, overflowToSavings = false, overflowNote }) {
  const paying = round2(amount);
  const b = await loanBalances(conn, loanId, { forUpdate: true });
  const open = b.loan.status === 'approved';

  if (!open && !overflowToSavings) {
    throw new RequestError(409, 'Only an approved, unpaid loan can receive repayments');
  }

  const totalOutstanding = open ? b.totalOutstanding : 0;
  if (paying > totalOutstanding && !overflowToSavings) {
    throw new RequestError(400, `That is more than the outstanding balance of KES ${totalOutstanding}`);
  }

  const applied = round2(Math.min(paying, totalOutstanding));
  const surplus = round2(paying - applied);
  const toInterest = round2(Math.min(applied, open ? b.interestOutstanding : 0));
  const toPrincipal = round2(applied - toInterest);
  const remaining = round2(totalOutstanding - applied);

  let loanRepaid = false;
  if (applied > 0) {
    await conn.query(
      'INSERT INTO loan_repayments (loan_id, amount_paid, interest_portion, principal_portion) VALUES (?, ?, ?, ?)',
      [loanId, applied, toInterest, toPrincipal]
    );
    await conn.query(
      'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
      [b.loan.group_id, b.loan.user_id, 'loan_repayment', applied, loanId]
    );
    if (remaining <= 0) {
      await conn.query('UPDATE loans SET status = ? WHERE id = ?', ['repaid', loanId]);
      loanRepaid = true;
    }
  }

  if (surplus > 0) {
    await recordSavings(conn, {
      groupId: b.loan.group_id,
      userId: b.loan.user_id,
      amount: surplus,
      note: overflowNote || 'Overpayment from loan repayment'
    });
  }

  return {
    loanAmount: parseFloat(b.loan.amount),
    applied,
    surplus,
    toInterest,
    toPrincipal,
    remaining,
    loanRepaid,
    loanAlreadyClosed: !open
  };
}

module.exports = { recordContribution, recordSavings, loanBalances, applyRepayment };