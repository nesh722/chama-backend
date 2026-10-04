const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');

// Helper: check if user is a member of a group, and get their role
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}
// Helper: current cycle label based on frequency
function getCurrentCycleLabel(frequency) {
  const now = new Date();
  if (frequency === 'weekly') {
    const target = new Date(now.valueOf());
    const dayNr = (now.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3) / 7);
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  } else {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}

// LOG A CONTRIBUTION (self-report by a member, or treasurer logging on someone's behalf)
exports.logContribution = async (req, res) => {
  try {
    const { group_id, amount, user_id } = req.body;
    const requesterId = req.user.userId;

    if (!group_id || !amount) {
      return res.status(400).json({ success: false, message: 'group_id and amount are required' });
    }

    const [groupRows] = await db.query('SELECT contribution_frequency FROM groups_table WHERE id = ?', [group_id]);
    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const cyclePeriod = getCurrentCycleLabel(groupRows[0].contribution_frequency);

    const requesterRole = await getMembership(group_id, requesterId);
    if (!requesterRole) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const targetUserId = user_id || requesterId;

    if (targetUserId !== requesterId && requesterRole !== 'treasurer') {
      return res.status(403).json({ success: false, message: 'Only the treasurer can log contributions for other members' });
    }

    const targetRole = await getMembership(group_id, targetUserId);
    if (!targetRole) {
      return res.status(400).json({ success: false, message: 'Target user is not a member of this group' });
    }

    const [existing] = await db.query(
      'SELECT id FROM contributions WHERE group_id = ? AND user_id = ? AND cycle_period = ?',
      [group_id, targetUserId, cyclePeriod]
    );

    let contributionId;
    if (existing.length > 0) {
      contributionId = existing[0].id;
      await db.query(
        'UPDATE contributions SET amount = ?, status = ?, paid_at = NOW() WHERE id = ?',
        [amount, 'paid', contributionId]
      );
    } else {
      const [result] = await db.query(
        'INSERT INTO contributions (group_id, user_id, amount, cycle_period, status, paid_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [group_id, targetUserId, amount, cyclePeriod, 'paid']
      );
      contributionId = result.insertId;
    }

    await db.query(
      'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
      [group_id, targetUserId, 'contribution', amount, contributionId]
    );

    await logActivity({
      userId: targetUserId,
      groupId: group_id,
      actionType: 'logged_contribution',
      description: `You made a contribution of KES ${amount} for ${cyclePeriod}`,
      amount
    });

    res.status(201).json({ success: true, message: 'Contribution logged successfully', contributionId, cyclePeriod });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// GET ALL CONTRIBUTIONS FOR A GROUP (with member names)
exports.getGroupContributions = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT c.id, u.full_name, c.amount, c.cycle_period, c.status, c.paid_at
       FROM contributions c
       JOIN users u ON c.user_id = u.id
       WHERE c.group_id = ?
       ORDER BY c.cycle_period DESC, u.full_name ASC`,
      [groupId]
    );

    res.json({ success: true, contributions: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET MY CONTRIBUTIONS ACROSS ALL GROUPS
exports.getMyContributions = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [rows] = await db.query(
      `SELECT c.id, g.name AS group_name, c.amount, c.cycle_period, c.status, c.paid_at
       FROM contributions c
       JOIN groups_table g ON c.group_id = g.id
       WHERE c.user_id = ?
       ORDER BY c.cycle_period DESC`,
      [userId]
    );

    res.json({ success: true, contributions: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET DEFAULTERS FOR A GIVEN CYCLE (who hasn't paid yet)
exports.getDefaulters = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { cycle_period } = req.query;
    const userId = req.user.userId;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }
    if (!cycle_period) {
      return res.status(400).json({ success: false, message: 'cycle_period query param is required' });
    }

    // Members who have NOT paid for this cycle
    const [rows] = await db.query(
      `SELECT u.id, u.full_name, u.phone
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ?
       AND u.id NOT IN (
         SELECT user_id FROM contributions
         WHERE group_id = ? AND cycle_period = ? AND status = 'paid'
       )`,
      [groupId, groupId, cycle_period]
    );

    res.json({ success: true, defaulters: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET MY CONTRIBUTION-DUE STATUS ACROSS ALL MY GROUPS
exports.getMyDueStatus = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [groups] = await db.query(
      `SELECT g.id, g.name, g.contribution_amount, g.contribution_frequency
       FROM group_members gm
       JOIN groups_table g ON gm.group_id = g.id
       WHERE gm.user_id = ?`,
      [userId]
    );

    const results = [];
    for (const group of groups) {
      const currentCycle = getCurrentCycleLabel(group.contribution_frequency);

      const [paidRows] = await db.query(
        `SELECT id FROM contributions WHERE group_id = ? AND user_id = ? AND cycle_period = ? AND status = 'paid'`,
        [group.id, userId, currentCycle]
      );

      results.push({
        groupId: group.id,
        groupName: group.name,
        amount: group.contribution_amount,
        frequency: group.contribution_frequency,
        currentCycle,
        isPaid: paidRows.length > 0
      });
    }

    res.json({ success: true, due: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};