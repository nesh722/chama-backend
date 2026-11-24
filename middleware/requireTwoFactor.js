// Put AFTER authMiddleware on routes that approve or confirm money.
// Treasurers and chairs who have not switched on two-step login are stopped here;
// everyone else passes through untouched.
const db = require('../config/db');

module.exports = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const [u] = await db.query('SELECT two_factor_enabled FROM users WHERE id = ?', [userId]);
    if (u.length > 0 && u[0].two_factor_enabled) return next();

    const [m] = await db.query(
      `SELECT 1 FROM group_members WHERE user_id = ? AND role IN ('treasurer', 'chair') LIMIT 1`,
      [userId]
    );
    if (m.length === 0) return next();

    return res.status(403).json({
      success: false,
      code: 'TWO_FACTOR_REQUIRED',
      message: 'Treasurers and chairs must turn on two-step login before approving or confirming money. Open Profile and switch it on.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
