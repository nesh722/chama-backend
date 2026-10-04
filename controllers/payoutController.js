const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');

// Helper: check membership + role
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// SET UP ROTATION ORDER FOR A GROUP (treasurer/chair only)
// Expects an array of user_ids in the order they should receive payouts
exports.setupRotation = async (req, res) => {
  try {
    const { group_id, user_order } = req.body; // user_order: [userId1, userId2, ...]
    const requesterId = req.user.userId;

    if (!group_id || !Array.isArray(user_order) || user_order.length === 0) {
      return res.status(400).json({ success: false, message: 'group_id and a non-empty user_order array are required' });
    }

    const role = await getMembership(group_id, requesterId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can set up the rotation' });
    }

    // Clear any existing rotation for this group (allows re-setup)
    await db.query('DELETE FROM payout_rotations WHERE group_id = ?', [group_id]);

    // Insert new rotation order
    for (let i = 0; i < user_order.length; i++) {
      const userId = user_order[i];
      const memberRole = await getMembership(group_id, userId);
      if (!memberRole) {
        return res.status(400).json({ success: false, message: `User ${userId} is not a member of this group` });
      }
      await db.query(
        'INSERT INTO payout_rotations (group_id, user_id, rotation_order) VALUES (?, ?, ?)',
        [group_id, userId, i + 1]
      );
    }

    res.status(201).json({ success: true, message: 'Rotation order set successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET ROTATION STATUS FOR A GROUP
exports.getRotationStatus = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT pr.id, u.full_name, pr.rotation_order, pr.has_received, pr.received_at
       FROM payout_rotations pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.group_id = ?
       ORDER BY pr.rotation_order ASC`,
      [groupId]
    );

    res.json({ success: true, rotation: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// MARK NEXT PERSON AS PAID OUT (treasurer/chair only)
exports.markPayout = async (req, res) => {
  try {
    const { group_id } = req.body;
    const requesterId = req.user.userId;

    if (!group_id) {
      return res.status(400).json({ success: false, message: 'group_id is required' });
    }

    const role = await getMembership(group_id, requesterId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can mark a payout' });
    }

    // Find the next person in rotation who hasn't received yet
    const [nextRows] = await db.query(
      `SELECT * FROM payout_rotations
       WHERE group_id = ? AND has_received = FALSE
       ORDER BY rotation_order ASC LIMIT 1`,
      [group_id]
    );

    if (nextRows.length === 0) {
      return res.status(409).json({ success: false, message: 'All members have already received their payout for this rotation cycle' });
    }

    const next = nextRows[0];

    // Get the group's contribution amount and member count to calculate payout total
    const [groupRows] = await db.query('SELECT contribution_amount FROM groups_table WHERE id = ?', [group_id]);
    const [memberCountRows] = await db.query('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?', [group_id]);
    const payoutAmount = parseFloat(groupRows[0].contribution_amount) * memberCountRows[0].count;

    await db.query(
      'UPDATE payout_rotations SET has_received = TRUE, received_at = NOW() WHERE id = ?',
      [next.id]
    );

    await db.query(
      'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
      [group_id, next.user_id, 'payout', payoutAmount, next.id]
    );

    await logActivity({
      userId: next.user_id,
      groupId: group_id,
      actionType: 'payout_received',
      description: `You received a payout of KES ${payoutAmount}`,
      amount: payoutAmount
    });

    res.json({ success: true, message: 'Payout marked successfully', paidToUserId: next.user_id, amount: payoutAmount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
