const { RequestError } = require('./idempotency');
const { MIN_APPROVERS, countApprovers } = require('./approvers');

// Same rule as loans: with fewer than MIN_APPROVERS treasurers / chairs there is nobody to be the second person.
async function assertPayoutsActive(groupId) {
  if ((await countApprovers(groupId)) < MIN_APPROVERS) {
    throw new RequestError(
      409,
      `Payouts are paused: this group needs at least ${MIN_APPROVERS} approvers (treasurer or chair) so every payout can be approved by a second person. Ask the group's leaders to assign another.`
    );
  }
}

// The payout for a turn is the contribution amount times the number of members.
async function payoutAmountFor(executor, groupId) {
  const [g] = await executor.query('SELECT contribution_amount FROM groups_table WHERE id = ?', [groupId]);
  const [c] = await executor.query('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?', [groupId]);
  return parseFloat(g[0].contribution_amount) * c[0].count;
}

const cents = (n) => Math.round(Number(n) * 100);

// Inside a transaction, with the turn already locked: the turn must have an APPROVED request for this exact amount.
// Returns the (now locked) approval row.
async function requireApproval(conn, { rotationId, amount }) {
  const [rows] = await conn.query(
    `SELECT * FROM payout_approvals WHERE rotation_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [rotationId]
  );
  if (rows.length === 0) {
    throw new RequestError(
      409,
      'This payout needs a second approver first. Request approval, and another treasurer or chair has to approve it.'
    );
  }
  if (cents(rows[0].amount) !== cents(amount)) {
    throw new RequestError(
      409,
      `The payout amount changed since it was approved (approved KES ${Number(rows[0].amount)}, now KES ${Number(amount)}). Cancel the approval and request it again.`
    );
  }
  return rows[0];
}

// One approval pays out one turn, once.
async function markApprovalUsed(conn, approvalId) {
  await conn.query(
    `UPDATE payout_approvals SET status = 'used', used_at = NOW() WHERE id = ? AND status = 'approved'`,
    [approvalId]
  );
}

async function markApprovalUsedForTurn(conn, rotationId) {
  await conn.query(
    `UPDATE payout_approvals SET status = 'used', used_at = NOW() WHERE rotation_id = ? AND status = 'approved'`,
    [rotationId]
  );
}

// Is an M-Pesa transfer for this turn in flight or already sent? (the table may not exist yet)
async function b2cInFlight(executor, rotationId) {
  try {
    const [rows] = await executor.query(
      `SELECT id FROM mpesa_b2c_transactions WHERE purpose = 'payout' AND reference_id = ? AND status IN ('pending', 'success') LIMIT 1`,
      [rotationId]
    );
    return rows.length > 0;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return false;
    throw err;
  }
}

module.exports = {
  assertPayoutsActive,
  payoutAmountFor,
  requireApproval,
  markApprovalUsed,
  markApprovalUsedForTurn,
  b2cInFlight
};