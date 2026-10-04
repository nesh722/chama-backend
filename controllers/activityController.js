const db = require('../config/db');

exports.getMyActivity = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [rows] = await db.query(
      `SELECT a.id, a.group_id, g.name AS group_name, a.action_type, a.description, a.amount, a.created_at
       FROM activity_log a
       LEFT JOIN groups_table g ON a.group_id = g.id
       WHERE a.user_id = ?
       ORDER BY a.created_at DESC`,
      [userId]
    );

    res.json({ success: true, activity: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
