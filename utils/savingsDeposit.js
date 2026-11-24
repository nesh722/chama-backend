// The one place an extra-savings deposit is written (deposit row + ledger row).
// Always call it inside a transaction: pass the connection.
async function insertSavingsDeposit(conn, { groupId, userId, amount, note }) {
  const [result] = await conn.query(
    'INSERT INTO savings_deposits (group_id, user_id, amount, note) VALUES (?, ?, ?, ?)',
    [groupId, userId, amount, note || null]
  );
  await conn.query(
    'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
    [groupId, userId, 'savings', amount, result.insertId]
  );
  return result.insertId;
}

module.exports = { insertSavingsDeposit };