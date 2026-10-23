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

// LOG EXTRA SAVINGS (voluntary, not tied to a contribution cycle)
exports.logSavings = async (req, res) => {
  try {
    const { group_id, amount, note, idempotency_key } = req.body;
    const userId = req.user.userId;
    const deposit = parseFloat(amount);

    if (!group_id || !deposit || deposit <= 0) {
      return res.status(400).json({ success: false, message: 'group_id and a positive amount are required' });
    }
    if (!validKey(idempotency_key)) {
      return res.status(400).json({ success: false, message: 'Invalid idempotency_key' });
    }

    const role = await getMembership(group_id, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const { replayed, payload } = await runOnce(
      { key: idempotency_key, userId, endpoint: 'log_savings' },
      async (conn) => {
        const [result] = await conn.query(
          'INSERT INTO savings_deposits (group_id, user_id, amount, note) VALUES (?, ?, ?, ?)',
          [group_id, userId, deposit, note || null]
        );
        await conn.query(
          'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
          [group_id, userId, 'savings', deposit, result.insertId]
        );
        return { success: true, message: 'Savings logged successfully', depositId: result.insertId };
      }
    );

    if (replayed) return res.status(200).json({ ...payload, duplicate: true });

    try {
      await logActivity({
        userId,
        groupId: group_id,
        actionType: 'logged_savings',
        description: note
          ? `You saved an extra KES ${deposit} — ${note}`
          : `You saved an extra KES ${deposit}`,
        amount: deposit
      });
    } catch (logErr) {
      console.log('Activity log failed:', logErr.message);
    }

    res.status(201).json(payload);
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
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
