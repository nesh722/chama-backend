const db = require('../config/db');

const MIN_APPROVERS = 2;

async function countApprovers(groupId) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND role IN ('treasurer', 'chair')`,
    [groupId]
  );
  return rows[0].count;
}

module.exports = { MIN_APPROVERS, countApprovers };