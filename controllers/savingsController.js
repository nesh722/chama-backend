const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');

// Helper: check membership
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// LOG EXTRA SAVINGS (voluntary, not tied to a contribution cycle)
exports.logSavings = async (req, res) => {
  try {
    const { group_id, amount, note } = req.body;
    const userId = req.user.userId;

    if (!group_id || !amount) {
      return res.status(400).json({ success: false, message: 'group_id and amount are required' });
    }

    const role = await getMembership(group_id, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [result] = await db.query(
      'INSERT INTO savings_deposits (group_id, user_id, amount, note) VALUES (?, ?, ?, ?)',
      [group_id, userId, amount, note || null]
    );

    // Log it in the unified transactions ledger too, same as contributions/loans/payouts
    await db.query(
      'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
      [group_id, userId, 'savings', amount, result.insertId]
    );

    await logActivity({
      userId,
      groupId: group_id,
      actionType: 'logged_savings',
      description: note
        ? `You saved an extra KES ${amount} — ${note}`
        : `You saved an extra KES ${amount}`,
      amount
    });

    res.status(201).json({ success: true, message: 'Savings logged successfully', depositId: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET ALL EXTRA SAVINGS FOR A GROUP (with member names)
exports.getGroupSavings = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT s.id, u.full_name, s.amount, s.note, s.deposited_at
       FROM savings_deposits s
       JOIN users u ON s.user_id = u.id
       WHERE s.group_id = ?
       ORDER BY s.deposited_at DESC`,
      [groupId]
    );

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
