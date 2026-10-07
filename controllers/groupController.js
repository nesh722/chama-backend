const db = require('../config/db');
const crypto = require('crypto');
const { logActivity } = require('../utils/activityLogService');

// Helper: check if user is a member of a group, and get their role
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// Helper: calculate how many contribution cycles have passed since a start date
function getCyclesElapsed(startDate, frequency) {
  const start = new Date(startDate);
  const now = new Date();
  if (frequency === 'weekly') {
    const diffMs = now - start;
    const weeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
    return Math.max(weeks, 1);
  } else {
    const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
    return Math.max(months, 1);
  }
}

// Helper: get this group's invite token, generating one on first request if it
// doesn't have one yet (lazy backfill -- no separate migration script needed)
async function getOrCreateInviteToken(groupId) {
  const [rows] = await db.query('SELECT invite_token FROM groups_table WHERE id = ?', [groupId]);
  if (rows.length === 0) return null;
  if (rows[0].invite_token) return rows[0].invite_token;

  const token = crypto.randomBytes(16).toString('hex');
  await db.query('UPDATE groups_table SET invite_token = ? WHERE id = ?', [token, groupId]);
  return token;
}

// CREATE GROUP — creator automatically becomes treasurer
exports.createGroup = async (req, res) => {
  try {
    const { name, description, contribution_amount, contribution_frequency } = req.body;
    const userId = req.user.userId;

    if (!name || !contribution_amount) {
      return res.status(400).json({ success: false, message: 'Name and contribution amount are required' });
    }

    const [result] = await db.query(
      'INSERT INTO groups_table (name, description, contribution_amount, contribution_frequency, created_by) VALUES (?, ?, ?, ?, ?)',
      [name, description || null, contribution_amount, contribution_frequency || 'monthly', userId]
    );

    const groupId = result.insertId;

    await db.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [groupId, userId, 'treasurer']
    );

    await logActivity({
      userId,
      groupId,
      actionType: 'created_group',
      description: `You created the group "${name}"`
    });

    res.status(201).json({ success: true, message: 'Group created successfully', groupId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// JOIN GROUP — by group ID
exports.joinGroup = async (req, res) => {
  try {
    const { group_id } = req.body;
    const userId = req.user.userId;

    if (!group_id) {
      return res.status(400).json({ success: false, message: 'group_id is required' });
    }

    const [groups] = await db.query('SELECT id, name FROM groups_table WHERE id = ?', [group_id]);
    if (groups.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const [existing] = await db.query(
      'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
      [group_id, userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Already a member of this group' });
    }

    await db.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [group_id, userId, 'member']
    );

    await logActivity({
      userId,
      groupId: group_id,
      actionType: 'joined_group',
      description: `You joined ${groups[0].name}`
    });

    res.status(201).json({ success: true, message: 'Joined group successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// JOIN GROUP — by invite token (from a scanned QR code or shared link)
exports.joinByToken = async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.userId;

    if (!token) {
      return res.status(400).json({ success: false, message: 'token is required' });
    }

    const [groups] = await db.query('SELECT id, name FROM groups_table WHERE invite_token = ?', [token]);
    if (groups.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired invite link' });
    }
    const group = groups[0];

    const [existing] = await db.query(
      'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
      [group.id, userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Already a member of this group' });
    }

    await db.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [group.id, userId, 'member']
    );

    await logActivity({
      userId,
      groupId: group.id,
      actionType: 'joined_group',
      description: `You joined ${group.name}`
    });

    res.status(201).json({ success: true, message: 'Joined group successfully', groupId: group.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// PREVIEW A GROUP BY INVITE TOKEN (public -- lets someone see what they're being
// invited to, even before logging in, without exposing membership-only data)
exports.previewByToken = async (req, res) => {
  try {
    const { token } = req.params;

    const [rows] = await db.query(
      'SELECT id, name, description, contribution_amount, contribution_frequency FROM groups_table WHERE invite_token = ?',
      [token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired invite link' });
    }

    res.json({ success: true, group: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET THIS GROUP'S INVITE TOKEN (any current member can fetch/share it)
exports.getInviteToken = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(id, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const token = await getOrCreateInviteToken(id);
    res.json({ success: true, invite_token: token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// REGENERATE THIS GROUP'S INVITE TOKEN (invalidates the old one; treasurer/chair only)
exports.regenerateInviteToken = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(id, userId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can regenerate the invite link' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    await db.query('UPDATE groups_table SET invite_token = ? WHERE id = ?', [token, id]);
    res.json({ success: true, invite_token: token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// LIST MY GROUPS
exports.getMyGroups = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [rows] = await db.query(
      `SELECT g.id, g.name, g.description, g.contribution_amount, g.contribution_frequency, gm.role
       FROM group_members gm
       JOIN groups_table g ON gm.group_id = g.id
       WHERE gm.user_id = ?`,
      [userId]
    );

    res.json({ success: true, groups: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET SINGLE GROUP DETAILS (with member list)
exports.getGroupDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const [groupRows] = await db.query('SELECT * FROM groups_table WHERE id = ?', [id]);
    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const [members] = await db.query(
      `SELECT u.id, u.full_name, u.email, gm.role, gm.joined_at
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ?`,
      [id]
    );

    res.json({ success: true, group: groupRows[0], members });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET MY OWN SAVINGS PROGRESS ACROSS ALL GROUPS WITH A TARGET SET
// (combines regular cycle contributions + voluntary extra savings deposits)
exports.getMySavingsProgress = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [groups] = await db.query(
      `SELECT g.id, g.name, g.savings_target, g.target_start_date, g.contribution_frequency
       FROM group_members gm
       JOIN groups_table g ON gm.group_id = g.id
       WHERE gm.user_id = ? AND g.savings_target IS NOT NULL`,
      [userId]
    );

    const results = [];
    for (const group of groups) {
      const cyclesElapsed = getCyclesElapsed(group.target_start_date, group.contribution_frequency);
      const targetToDate = parseFloat(group.savings_target) * cyclesElapsed;

      const [contribRows] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM contributions WHERE group_id = ? AND user_id = ? AND status = 'paid'`,
        [group.id, userId]
      );
      const [savingsRows] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM savings_deposits WHERE group_id = ? AND user_id = ?`,
        [group.id, userId]
      );
      const paidToDate = parseFloat(contribRows[0].total) + parseFloat(savingsRows[0].total);
      const shortfall = targetToDate - paidToDate;

      results.push({
        groupId: group.id,
        groupName: group.name,
        savingsTarget: group.savings_target,
        cyclesElapsed,
        paidToDate,
        targetToDate,
        shortfall: shortfall > 0 ? shortfall : 0,
        onTrack: shortfall <= 0
      });
    }

    res.json({ success: true, progress: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// SET SAVINGS TARGET (treasurer/chair only) -- archives the previous target first, if any
exports.setSavingsTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const { savings_target } = req.body;
    const userId = req.user.userId;

    if (!savings_target || savings_target <= 0) {
      return res.status(400).json({ success: false, message: 'A valid savings_target is required' });
    }

    const role = await getMembership(id, userId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can set the savings target' });
    }

    const [groupRows] = await db.query(
      'SELECT savings_target, target_start_date, name FROM groups_table WHERE id = ?',
      [id]
    );
    const existing = groupRows[0];
    const isUpdate = !!(existing && existing.savings_target);

    if (isUpdate) {
      await db.query(
        `INSERT INTO savings_target_history (group_id, savings_target, target_start_date, target_end_date, ended_reason)
         VALUES (?, ?, ?, CURDATE(), 'replaced')`,
        [id, existing.savings_target, existing.target_start_date]
      );
    }

    await db.query(
      'UPDATE groups_table SET savings_target = ?, target_start_date = CURDATE() WHERE id = ?',
      [savings_target, id]
    );

    await logActivity({
      userId,
      groupId: id,
      actionType: isUpdate ? 'savings_target_updated' : 'savings_target_set',
      description: isUpdate
        ? `You updated the savings target for ${existing.name} to KES ${savings_target} per cycle (was KES ${existing.savings_target})`
        : `You set a savings target of KES ${savings_target} per cycle for ${existing.name}`
    });

    res.json({ success: true, message: 'Savings target set successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// REMOVE SAVINGS TARGET (treasurer/chair only) -- archives it rather than discarding it
exports.removeSavingsTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(id, userId);
    if (role !== 'treasurer' && role !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can remove the savings target' });
    }

    const [groupRows] = await db.query(
      'SELECT savings_target, target_start_date, name FROM groups_table WHERE id = ?',
      [id]
    );
    const existing = groupRows[0];

    if (!existing || !existing.savings_target) {
      return res.status(400).json({ success: false, message: 'This group has no savings target set' });
    }

    await db.query(
      `INSERT INTO savings_target_history (group_id, savings_target, target_start_date, target_end_date, ended_reason)
       VALUES (?, ?, ?, CURDATE(), 'removed')`,
      [id, existing.savings_target, existing.target_start_date]
    );

    await db.query(
      'UPDATE groups_table SET savings_target = NULL, target_start_date = NULL WHERE id = ?',
      [id]
    );

     await logActivity({
      userId,
      groupId: id,
      actionType: 'savings_target_removed',
      description: `You removed the KES ${existing.savings_target} savings target for ${existing.name}`
    });

    res.json({ success: true, message: 'Savings target removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// GET SAVINGS PROGRESS FOR ALL MEMBERS
// (combines regular cycle contributions + voluntary extra savings deposits)
exports.getSavingsProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(id, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [groupRows] = await db.query(
      'SELECT savings_target, target_start_date, contribution_frequency FROM groups_table WHERE id = ?',
      [id]
    );
    const group = groupRows[0];

    if (!group.savings_target) {
      return res.json({ success: true, targetSet: false, progress: [] });
    }

    const cyclesElapsed = getCyclesElapsed(group.target_start_date, group.contribution_frequency);
    const targetToDate = parseFloat(group.savings_target) * cyclesElapsed;

    const [members] = await db.query(
      `SELECT u.id, u.full_name,
        COALESCE((SELECT SUM(amount) FROM contributions WHERE user_id = u.id AND group_id = gm.group_id AND status = 'paid'), 0)
        + COALESCE((SELECT SUM(amount) FROM savings_deposits WHERE user_id = u.id AND group_id = gm.group_id), 0) AS paidToDate
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ?
       GROUP BY u.id, u.full_name`,
      [id]
    );

    const progress = members.map((m) => {
      const paid = parseFloat(m.paidToDate);
      const shortfall = targetToDate - paid;
      return {
        id: m.id,
        full_name: m.full_name,
        paidToDate: paid,
        targetToDate,
        shortfall: shortfall > 0 ? shortfall : 0,
        onTrack: shortfall <= 0
      };
    });

    res.json({ success: true, targetSet: true, savingsTarget: group.savings_target, cyclesElapsed, progress });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// CHANGE A MEMBER'S ROLE (treasurer/chair only)
exports.changeRole = async (req, res) => {
  try {
    const { id } = req.params; // group id
    const { member_user_id, new_role } = req.body;
    const requesterId = req.user.userId;

    const validRoles = ['chair', 'treasurer', 'secretary', 'member'];
    if (!member_user_id || !validRoles.includes(new_role)) {
      return res.status(400).json({ success: false, message: 'member_user_id and a valid new_role are required' });
    }

    const requesterRole = await getMembership(id, requesterId);
    if (requesterRole !== 'treasurer' && requesterRole !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can change member roles' });
    }

    const targetRole = await getMembership(id, member_user_id);
    if (!targetRole) {
      return res.status(404).json({ success: false, message: 'That user is not a member of this group' });
    }

    // Prevent a group from ending up with zero treasurer/chair members
    if ((targetRole === 'treasurer' || targetRole === 'chair') && new_role !== 'treasurer' && new_role !== 'chair') {
      const [approverCount] = await db.query(
        `SELECT COUNT(*) AS count FROM group_members
         WHERE group_id = ? AND role IN ('treasurer', 'chair')`,
        [id]
      );
      if (approverCount[0].count <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot remove the last treasurer/chair — assign another approver first'
        });
      }
    }

    await db.query(
      'UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?',
      [new_role, id, member_user_id]
    );

    await logActivity({
      userId: member_user_id,
      groupId: id,
      actionType: 'role_changed',
      description: `Your role in this group was changed to ${new_role}`
    });

    res.json({ success: true, message: 'Role updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// REMOVE A MEMBER (treasurer/chair only)
exports.removeMember = async (req, res) => {
  try {
    const { id } = req.params; // group id
    const { member_user_id } = req.body;
    const requesterId = req.user.userId;

    if (!member_user_id) {
      return res.status(400).json({ success: false, message: 'member_user_id is required' });
    }

    if (parseInt(member_user_id) === requesterId) {
      return res.status(400).json({ success: false, message: 'You cannot remove yourself this way' });
    }

    const requesterRole = await getMembership(id, requesterId);
    if (requesterRole !== 'treasurer' && requesterRole !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only treasurer or chair can remove members' });
    }

    const targetRole = await getMembership(id, member_user_id);
    if (!targetRole) {
      return res.status(404).json({ success: false, message: 'That user is not a member of this group' });
    }

    if (targetRole === 'treasurer' || targetRole === 'chair') {
      const [approverCount] = await db.query(
        `SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND role IN ('treasurer', 'chair')`,
        [id]
      );
      if (approverCount[0].count <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot remove the last treasurer/chair — assign another approver first'
        });
      }
    }

    const [groupRows] = await db.query('SELECT name FROM groups_table WHERE id = ?', [id]);

    await db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [id, member_user_id]);

    await logActivity({
      userId: member_user_id,
      groupId: id,
      actionType: 'removed_from_group',
      description: `You were removed from ${groupRows[0]?.name || 'a group'}`
    });

    res.json({ success: true, message: 'Member removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// DELETE GROUP (creator only)
exports.deleteGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const [groupRows] = await db.query('SELECT created_by, name FROM groups_table WHERE id = ?', [id]);
    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    if (groupRows[0].created_by !== userId) {
      return res.status(403).json({ success: false, message: 'Only the group creator can delete this group' });
    }

    const [outstandingLoans] = await db.query(
      `SELECT COUNT(*) AS count FROM loans WHERE group_id = ? AND status IN ('requested', 'approved')`,
      [id]
    );
    if (outstandingLoans[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete this group while there are unpaid or pending loans'
      });
    }

    // Log this BEFORE deleting the group — activity_log.group_id has a foreign key
    // to groups_table, so the referenced row must still exist at insert time.
    await logActivity({
      userId,
      groupId: id,
      actionType: 'deleted_group',
      description: `You deleted the group "${groupRows[0].name}"`
    });

    await db.query('DELETE FROM groups_table WHERE id = ?', [id]);

    res.json({ success: true, message: 'Group deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET SAVINGS TARGET HISTORY FOR A GROUP
exports.getSavingsTargetHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const role = await getMembership(id, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const [rows] = await db.query(
      `SELECT id, savings_target, target_start_date, target_end_date, ended_reason, created_at
       FROM savings_target_history
       WHERE group_id = ?
       ORDER BY target_end_date DESC`,
      [id]
    );

    res.json({ success: true, history: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
