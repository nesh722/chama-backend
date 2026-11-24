const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');
const { runOnce, RequestError, validKey } = require('../utils/idempotency');

// Helper: check membership
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// Cash savings now go through a cash claim (kind 'extra_savings') that a treasurer / chair confirms.
// M-Pesa savings are recorded automatically by the M-Pesa callback.
exports.logSavings = async (req, res) => {
  res.status(410).json({
    success: false,
    message: 'Cash savings now need to be confirmed by the treasurer or chair who received them. Update the app and use "I paid cash".'
  });
};

// GET ALL EXTRA SAVINGS FOR A GROUP (with member names)
// Members see only their own entries; treasurer/chair see everyone's.
exports.getGroupSavings = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const isApprover = role === 'treasurer' || role === 'chair';

    const query = `
      SELECT s.id, u.full_name, s.amount, s.note, s.deposited_at
      FROM savings_deposits s
      JOIN users u ON s.user_id = u.id
      WHERE s.group_id = ? ${isApprover ? '' : 'AND s.user_id = ?'}
      ORDER BY s.deposited_at DESC`;
    const params = isApprover ? [groupId] : [groupId, userId];

    const [rows] = await db.query(query, params);

    res.json({ success: true, savings: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET MY EXTRA SAVINGS ACROSS ALL GROUPS
exports.getMySavings = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [rows] = await db.query(
      `SELECT s.id, g.name AS group_name, s.amount, s.note, s.deposited_at
       FROM savings_deposits s
       JOIN groups_table g ON s.group_id = g.id
       WHERE s.user_id = ?
       ORDER BY s.deposited_at DESC`,
      [userId]
    );

    res.json({ success: true, savings: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
