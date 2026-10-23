const db = require('../config/db');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');
const { getCurrentCycleLabel, describeCycle } = require('../utils/cycle');
const { claimKey, saveResponse, releaseKey } = require('../utils/idempotency');
// Helper: check if user is a member of a group, and get their role
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// LOG A CONTRIBUTION (self-report by a member, or treasurer logging on someone's behalf)
exports.logContribution = async (req, res) => {
  try {
    const { group_id, amount, user_id, idempotency_key } = req.body;
    const requesterId = req.user.userId;

    const paying = parseFloat(amount);
    if (!group_id || !paying || paying <= 0) {
      return res.status(400).json({ success: false, message: 'group_id and a positive amount are required' });
    }
    if (
      idempotency_key !== undefined &&
      (typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 64)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid idempotency_key' });
    }

    const [groupRows] = await db.query(
      'SELECT contribution_amount, contribution_frequency, cycle_anchor_date FROM groups_table WHERE id = ?',
      [group_id]
    );
    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const group = groupRows[0];
    const cyclePeriod = getCurrentCycleLabel(group.contribution_frequency, group.cycle_anchor_date);

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

    // Validation is done, so claim the key. A retry of a payment that already went through
    // gets the saved result back instead of being added a second time.
    let keyClaimed = false;
    if (idempotency_key) {
      const claim = await claimKey(idempotency_key, requesterId, 'log_contribution');
      if (claim.status === 'done') {
        return res.status(200).json({ ...claim.response, duplicate: true });
      }
      if (claim.status === 'in_progress') {
        return res.status(409).json({ success: false, message: 'This payment is already being processed. Please wait a moment.' });
      }
      keyClaimed = true;
    }

    const target = parseFloat(group.contribution_amount);
    let payload;

    // The contribution row and the ledger entry are saved together or not at all
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [existing] = await conn.query(
        'SELECT id, amount FROM contributions WHERE group_id = ? AND user_id = ? AND cycle_period = ? FOR UPDATE',
        [group_id, targetUserId, cyclePeriod]
      );

      const alreadyPaid = existing.length > 0 ? parseFloat(existing[0].amount) : 0;
      const newTotal = alreadyPaid + paying;
      const status = newTotal >= target ? 'paid' : 'partial';
      const remaining = Math.max(target - newTotal, 0);

      let contributionId;
      if (existing.length > 0) {
        contributionId = existing[0].id;
        await conn.query(
          'UPDATE contributions SET amount = ?, status = ?, paid_at = NOW() WHERE id = ?',
          [newTotal, status, contributionId]
        );
      } else {
        const [result] = await conn.query(
          'INSERT INTO contributions (group_id, user_id, amount, cycle_period, status, paid_at) VALUES (?, ?, ?, ?, ?, NOW())',
          [group_id, targetUserId, newTotal, cyclePeriod, status]
        );
        contributionId = result.insertId;
      }

      await conn.query(
        'INSERT INTO transactions (group_id, user_id, type, amount, reference_id) VALUES (?, ?, ?, ?, ?)',
        [group_id, targetUserId, 'contribution', paying, contributionId]
      );

      await conn.commit();

      payload = {
        success: true,
        message: 'Contribution logged successfully',
        contributionId,
        cyclePeriod,
        status,
        paidSoFar: newTotal,
        remaining
      };
    } catch (writeErr) {
      await conn.rollback();
      if (keyClaimed) await releaseKey(idempotency_key, requesterId);
      throw writeErr;
    } finally {
      conn.release();
    }

    // The payment is committed. Everything below is best-effort and must never undo or re-run it.
    try {
      await logActivity({
        userId: targetUserId,
        groupId: group_id,
        actionType: 'logged_contribution',
        description: payload.remaining > 0
          ? `You paid KES ${paying} toward ${cyclePeriod} (KES ${payload.remaining} still remaining)`
          : `You completed your KES ${target} contribution for ${cyclePeriod}`,
        amount: paying
      });
    } catch (logErr) {
      console.log('Activity log failed:', logErr.message);
    }

    if (keyClaimed) {
      try {
        await saveResponse(idempotency_key, requesterId, payload);
      } catch (saveErr) {
        console.log('Saving idempotency response failed:', saveErr.message);
      }
    }

    return res.status(201).json(payload);
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
      `SELECT c.id, c.user_id, u.full_name, c.amount, c.cycle_period, c.status, c.paid_at
       FROM contributions c
       JOIN users u ON c.user_id = u.id
       WHERE c.group_id = ?
      ORDER BY c.paid_at DESC, c.id DESC`,
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
      `SELECT g.id, g.name, g.contribution_amount, g.contribution_frequency, g.cycle_anchor_date
       FROM group_members gm
       JOIN groups_table g ON gm.group_id = g.id
       WHERE gm.user_id = ?`,
      [userId]
    );

    const results = [];
    for (const group of groups) {
      const currentCycle = getCurrentCycleLabel(group.contribution_frequency, group.cycle_anchor_date);

      const [rows] = await db.query(
        'SELECT amount, status FROM contributions WHERE group_id = ? AND user_id = ? AND cycle_period = ?',
        [group.id, userId, currentCycle]
      );
      const row = rows[0];
      const isPaid = !!row && row.status === 'paid';
      const paidSoFar = row ? parseFloat(row.amount) : 0;
      const remaining = isPaid ? 0 : Math.max(parseFloat(group.contribution_amount) - paidSoFar, 0);

      results.push({
        groupId: group.id,
        groupName: group.name,
        amount: group.contribution_amount,
        frequency: group.contribution_frequency,
        currentCycle,
        isPaid,
        paidSoFar,
        remaining
      });
    }
    res.json({ success: true, due: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// SEND CONTRIBUTION REMINDER(S) (treasurer/chair only)
// With user_id: reminds that one member. Without it: reminds everyone who hasn't paid in full.
exports.sendContributionReminder = async (req, res) => {
  try {
    const { group_id, user_id } = req.body;
    const senderId = req.user.userId;

    if (!group_id) {
      return res.status(400).json({ success: false, message: 'group_id is required' });
    }

    const senderRole = await getMembership(group_id, senderId);
    if (senderRole !== 'treasurer' && senderRole !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only the treasurer or chair can send reminders' });
    }

    const [groupRows] = await db.query(
      'SELECT name, contribution_amount, contribution_frequency, cycle_anchor_date FROM groups_table WHERE id = ?',
      [group_id]
    );
    if (groupRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const group = groupRows[0];
    const cycle = getCurrentCycleLabel(group.contribution_frequency, group.cycle_anchor_date);
    const target = parseFloat(group.contribution_amount);

    // Members (other than the sender) who haven't paid in full this cycle, with what they've paid so far
    const params = [cycle, group_id, senderId];
    let sql = `SELECT gm.user_id, u.full_name, COALESCE(c.amount, 0) AS paid
               FROM group_members gm
               JOIN users u ON gm.user_id = u.id
               LEFT JOIN contributions c
                 ON c.group_id = gm.group_id AND c.user_id = gm.user_id AND c.cycle_period = ?
               WHERE gm.group_id = ? AND gm.user_id != ?
               AND (c.id IS NULL OR c.status != 'paid')`;
    if (user_id) {
      sql += ' AND gm.user_id = ?';
      params.push(user_id);
    }
    const [owing] = await db.query(sql, params);

    if (user_id && owing.length === 0) {
      if (Number(user_id) === senderId) {
        return res.status(400).json({ success: false, message: 'You cannot send a reminder to yourself' });
      }
      const targetRole = await getMembership(group_id, user_id);
      if (!targetRole) {
        return res.status(400).json({ success: false, message: 'That user is not a member of this group' });
      }
      return res.status(400).json({ success: false, message: 'That member has already paid in full for this cycle' });
    }

    let sent = 0;
    let skipped = 0;

    for (const m of owing) {
      // Cooldown: one reminder per member per cycle every 24 hours
      const [recent] = await db.query(
        `SELECT id FROM contribution_reminders
         WHERE group_id = ? AND user_id = ? AND cycle_period = ?
         AND sent_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) LIMIT 1`,
        [group_id, m.user_id, cycle]
      );
      if (recent.length > 0) {
        skipped++;
        continue;
      }

      const remaining = Math.max(target - parseFloat(m.paid), 0);
      try {
        await createNotification(
          m.user_id,
          'Contribution Reminder',
          `Your contribution for ${describeCycle(cycle)} in ${group.name} is still pending. KES ${remaining} remaining of KES ${target}.`
        );
        await db.query(
          'INSERT INTO contribution_reminders (group_id, user_id, cycle_period, sent_by) VALUES (?, ?, ?, ?)',
          [group_id, m.user_id, cycle, senderId]
        );
        sent++;
      } catch (err) {
        console.log(`Reminder failed for user ${m.user_id}:`, err.message);
      }
    }

    if (sent === 0 && skipped > 0) {
      return res.status(429).json({
        success: false,
        message: user_id
          ? 'This member was already reminded in the last 24 hours'
          : 'Everyone who owes was already reminded in the last 24 hours',
        sent,
        skipped
      });
    }
    if (sent === 0) {
      return res.json({ success: true, sent: 0, skipped, message: 'Everyone has paid in full for this cycle' });
    }

    await logActivity({
      userId: senderId,
      groupId: group_id,
      actionType: 'sent_reminder',
      description: user_id
        ? `You sent a contribution reminder to ${owing[0].full_name}`
        : `You sent contribution reminders to ${sent} member${sent === 1 ? '' : 's'}`
    });

    res.json({ success: true, sent, skipped, message: 'Reminder sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};