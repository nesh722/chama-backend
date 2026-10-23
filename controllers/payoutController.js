const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');
const { runOnce, RequestError, validKey } = require('../utils/idempotency');

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

    // Archive the current rotation (if there is one) before replacing it
    const [existingRows] = await db.query(
      'SELECT id FROM payout_rotations WHERE group_id = ? LIMIT 1',
      [group_id]
    );
    if (existingRows.length > 0) {
      const [cycleRows] = await db.query(
        'SELECT COALESCE(MAX(cycle_number), 0) + 1 AS next_cycle FROM payout_rotation_history WHERE group_id = ?',
        [group_id]
      );
      const nextCycle = cycleRows[0].next_cycle;

      await db.query(
        `INSERT INTO payout_rotation_history
           (group_id, cycle_number, user_id, rotation_order, has_received, received_at, amount)
         SELECT pr.group_id, ?, pr.user_id, pr.rotation_order, pr.has_received, pr.received_at, t.amount
         FROM payout_rotations pr
         LEFT JOIN transactions t ON t.type = 'payout' AND t.reference_id = pr.id
         WHERE pr.group_id = ?`,
        [nextCycle, group_id]
      );
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
    const { group_id, idempotency_key } = req.body;
    const requesterId = req.user.userId;

    if (!group_id) {
      return res.status(400).json({ success: false, message: 'group_id is required' });
    }
    if (!validKey(idempotency_key)) {
      return res.status(400).json({ success: false, message: 'Invalid idempotency_key' });
    }

    const role = await getMembership(group_id, requesterId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can mark a payout' });
    }

    const { replayed, payload } = await runOnce(
      { key: idempotency_key, userId: requesterId, endpoint: 'mark_payout' },
      async (conn) => {
        // Lock the next unpaid turn so two requests can't both take it
        const [nextRows] = await conn.query(
          `SELECT id, user_id FROM payout_rotations
           WHERE group_id = ? AND has_received = FALSE
           ORDER BY rotation_order ASC LIMIT 1 FOR UPDATE`,
          [group_id]
        );
        if (nextRows.length === 0) {
          throw new RequestError(409, 'All members have already received their payout for this rotation cycle');
        }
        const next = nextRows[0];

        const [groupRows] = await conn.query('SELECT contribution_amount FROM groups_table WHERE id = ?', [group_id]);
        const [countRows] = await conn.query('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?', [group_id]);
        const payoutAmount = parseFloat(groupRows[0].contribution_amount) * countRows[0].count;

        const [updated] = await conn.query(
          'UPDATE payout_rotations SET has_received = TRUE, received_at = NOW() WHERE id = ? AND has_received = FALSE',
          [next.id]
        );
        if (updated.affectedRows === 0) {
          throw new RequestError(409, 'That payout was just recorded. Please refresh.');
        }

        await conn.query(
          'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
          [group_id, next.user_id, 'payout', payoutAmount, next.id]
        );

        return {
          success: true,
          message: 'Payout marked successfully',
          paidToUserId: next.user_id,
          amount: payoutAmount
        };
      }
    );

    if (replayed) return res.status(200).json({ ...payload, duplicate: true });

    try {
      await logActivity({
        userId: payload.paidToUserId,
        groupId: group_id,
        actionType: 'payout_received',
        description: `You received a payout of KES ${payload.amount}`,
        amount: payload.amount
      });
    } catch (logErr) {
      console.log('Activity log failed:', logErr.message);
    }

    res.json(payload);
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};
// GET PAYOUT ROTATION HISTORY FOR A GROUP (past cycles)
exports.getRotationHistory = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT h.id, h.cycle_number, u.full_name, h.rotation_order, h.has_received,
              h.received_at, h.amount, h.archived_at
       FROM payout_rotation_history h
       JOIN users u ON h.user_id = u.id
       WHERE h.group_id = ?
       ORDER BY h.cycle_number DESC, h.rotation_order ASC`,
      [groupId]
    );

    res.json({ success: true, history: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};