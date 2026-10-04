const db = require('../config/db');

async function logActivity({ userId, groupId = null, actionType, description, amount = null }) {
  await db.query(
    'INSERT INTO activity_log (user_id, group_id, action_type, description, amount) VALUES (?, ?, ?, ?, ?)',
    [userId, groupId, actionType, description, amount]
  );
}

module.exports = { logActivity };
