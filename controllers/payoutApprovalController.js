const db = require('../config/db');
const { RequestError } = require('../utils/idempotency');
const { MIN_APPROVERS, countApprovers } = require('../utils/approvers');
const { assertPayoutsActive, payoutAmountFor, b2cInFlight } = require('../utils/payoutApproval');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');

async function getMembership(groupId, userId, executor = db) {
  const [rows] = await executor.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

const isApprover = (role) => role === 'treasurer' || role === 'chair';
const sameMoney = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);

async function nameOf(userId) {
  if (!userId) return null;
  const [rows] = await db.query('SELECT full_name FROM users WHERE id = ?', [userId]);
  return rows[0] ? rows[0].full_name : null;
}

// Best-effort: the decision is already saved, so a notification hiccup must never fail the request
async function tell(userIds, title, message) {
  for (const id of userIds) {
    try {
      await createNotification(id, title, message);
    } catch (err) {
      console.log('Payout approval notification failed:', err.message);
    }
  }
}

// POST /api/payouts/request   body: { group_id }
exports.requestApproval = async (req, res) => {
  try {
    const requesterId = Number(req.user.userId);
    const groupId = req.body.group_id;
    if (!groupId) {
      return res.status(400).json({ success: false, message: 'group_id is required' });
    }

    const role = await getMembership(groupId, requesterId);
    if (!isApprover(role)) {
      return res.status(403).json({ success: false, message: 'Only the treasurer or chair can request a payout' });
    }
    await assertPayoutsActive(groupId);

    const conn = await db.getConnection();
    let turn;
    let amount;
    let eligible;
    let approvalId;
    try {
      await conn.beginTransaction();

      // Lock the next unpaid turn so two requests can't both open an approval for it
      const [next] = await conn.query(
        `SELECT id, user_id FROM payout_rotations
         WHERE group_id = ? AND has_received = FALSE
         ORDER BY rotation_order ASC LIMIT 1 FOR UPDATE`,
        [groupId]
      );
      if (next.length === 0) {
        throw new RequestError(409, 'All members have already received their payout for this rotation cycle');
      }
      turn = next[0];

      const [open] = await conn.query(
        `SELECT id, status FROM payout_approvals WHERE rotation_id = ? AND status IN ('requested', 'approved') LIMIT 1 FOR UPDATE`,
        [turn.id]
      );
      if (open.length > 0) {
        throw new RequestError(
          409,
          open[0].status === 'approved'
            ? 'This payout is already approved. You can go ahead and pay it out.'
            : 'This payout is already waiting for approval.'
        );
      }

      amount = await payoutAmountFor(conn, groupId);

      // Someone other than the requester, and other than the person being paid, has to be able to approve it
      const [others] = await conn.query(
        `SELECT user_id FROM group_members
         WHERE group_id = ? AND role IN ('treasurer', 'chair') AND user_id NOT IN (?, ?)`,
        [groupId, requesterId, turn.user_id]
      );
      eligible = others.map((o) => o.user_id);
      if (eligible.length === 0) {
        const recipientName = (await nameOf(turn.user_id)) || 'the member being paid';
        throw new RequestError(
          409,
          `Nobody else could approve a request from you, because the payout is going to ${recipientName}. Ask ${recipientName} to raise the request so the other treasurer or chair can approve it.`
        );
      }

      const [ins] = await conn.query(
        `INSERT INTO payout_approvals (group_id, rotation_id, recipient_id, amount, requested_by)
         VALUES (?, ?, ?, ?, ?)`,
        [groupId, turn.id, turn.user_id, amount, requesterId]
      );
      approvalId = ins.insertId;

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const requesterName = (await nameOf(requesterId)) || 'A treasurer';
    const recipientName = (await nameOf(turn.user_id)) || 'a member';
    try {
      await logActivity({
        userId: requesterId,
        groupId,
        actionType: 'payout_requested',
        description: `You asked for approval to pay KES ${amount} to ${recipientName}`,
        amount
      });
    } catch (logErr) {
      console.log('Activity log failed:', logErr.message);
    }
    await tell(
      eligible,
      'Payout Needs Approval',
      `${requesterName} asked to pay KES ${amount} to ${recipientName}. Open the Payouts tab to approve or reject it.`
    );

    res.status(201).json({ success: true, message: 'Approval requested', approvalId });
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

// PATCH /api/payouts/approvals/:approvalId/decide   body: { decision: 'approved' | 'rejected' }
exports.decide = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { approvalId } = req.params;
    const { decision } = req.body;

    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be "approved" or "rejected"' });
    }

    const conn = await db.getConnection();
    let row;
    let staleReason = null;
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query('SELECT * FROM payout_approvals WHERE id = ? FOR UPDATE', [approvalId]);
      if (rows.length === 0) {
        throw new RequestError(404, 'Approval request not found');
      }
      row = rows[0];

      if (row.status !== 'requested') {
        throw new RequestError(409, `This request is already ${row.status}`);
      }

      const role = await getMembership(row.group_id, userId, conn);
      if (!isApprover(role)) {
        throw new RequestError(403, 'Only the treasurer or chair can approve or reject a payout');
      }
      if (Number(row.requested_by) === userId) {
        throw new RequestError(403, 'You asked for this payout, so another treasurer or chair has to approve it');
      }
      if (Number(row.recipient_id) === userId) {
        throw new RequestError(403, 'You cannot approve or reject a payout that is going to you');
      }
      await assertPayoutsActive(row.group_id);

      // The request has to still describe reality: same turn, nobody paid it yet, same amount
      const [turn] = await conn.query('SELECT id, has_received FROM payout_rotations WHERE id = ?', [row.rotation_id]);
      if (turn.length === 0 || turn[0].has_received) {
        staleReason = 'This request is out of date: that turn was already paid or the rotation was reset.';
      } else if (!sameMoney(await payoutAmountFor(conn, row.group_id), row.amount)) {
        staleReason = 'The payout amount changed since this was requested. Cancel it and request it again.';
      }

      if (staleReason) {
        if (turn.length === 0 || turn[0].has_received) {
          await conn.query(`UPDATE payout_approvals SET status = 'cancelled' WHERE id = ?`, [row.id]);
        }
      } else {
        await conn.query(
          'UPDATE payout_approvals SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ?',
          [decision, userId, row.id]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (staleReason) {
      return res.status(409).json({ success: false, message: staleReason });
    }

    const deciderName = (await nameOf(userId)) || 'Another treasurer';
    const recipientName = (await nameOf(row.recipient_id)) || 'a member';
    const amt = Number(row.amount);
    try {
      await logActivity({
        userId: row.requested_by,
        groupId: row.group_id,
        actionType: decision === 'approved' ? 'payout_approved' : 'payout_rejected',
        description:
          decision === 'approved'
            ? `${deciderName} approved your payout of KES ${amt} to ${recipientName}`
            : `${deciderName} rejected your payout of KES ${amt} to ${recipientName}`,
        amount: amt
      });
    } catch (logErr) {
      console.log('Activity log failed:', logErr.message);
    }
    await tell(
      [row.requested_by],
      decision === 'approved' ? 'Payout Approved' : 'Payout Rejected',
      decision === 'approved'
        ? `${deciderName} approved the payout of KES ${amt} to ${recipientName}. You can pay it out now.`
        : `${deciderName} rejected the payout of KES ${amt} to ${recipientName}.`
    );

    res.json({ success: true, message: `Payout ${decision}` });
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/payouts/approvals/:approvalId/cancel
// Withdraws a request, or takes back an approval that has not been used yet.
exports.cancel = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { approvalId } = req.params;

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query('SELECT * FROM payout_approvals WHERE id = ? FOR UPDATE', [approvalId]);
      if (rows.length === 0) {
        throw new RequestError(404, 'Approval request not found');
      }
      const row = rows[0];

      const role = await getMembership(row.group_id, userId, conn);
      if (!isApprover(role)) {
        throw new RequestError(403, 'Only the treasurer or chair can cancel a payout request');
      }
      if (!['requested', 'approved'].includes(row.status)) {
        throw new RequestError(409, `This request is already ${row.status}`);
      }
      if (await b2cInFlight(conn, row.rotation_id)) {
        throw new RequestError(409, 'An M-Pesa transfer for this payout is in progress or already sent, so it cannot be cancelled.');
      }

      await conn.query(`UPDATE payout_approvals SET status = 'cancelled' WHERE id = ?`, [row.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: 'Cancelled' });
  } catch (err) {
    if (err instanceof RequestError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/payouts/approval/:groupId
// Where the NEXT payout turn stands: who is being paid, how much, and its latest approval request.
exports.getCurrent = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { groupId } = req.params;

    const role = await getMembership(groupId, userId);
    if (!role) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    const approverCount = await countApprovers(groupId);
    const base = { success: true, paused: approverCount < MIN_APPROVERS, approverCount, minApprovers: MIN_APPROVERS };

    const [next] = await db.query(
      `SELECT id, user_id FROM payout_rotations
       WHERE group_id = ? AND has_received = FALSE
       ORDER BY rotation_order ASC LIMIT 1`,
      [groupId]
    );
    if (next.length === 0) {
      return res.json({ ...base, turn: null, approval: null });
    }
    const turn = next[0];

    const amount = await payoutAmountFor(db, groupId);
    const recipientName = await nameOf(turn.user_id);

    const [rows] = await db.query(
      `SELECT * FROM payout_approvals
       WHERE rotation_id = ? AND status IN ('requested', 'approved', 'rejected')
       ORDER BY id DESC LIMIT 1`,
      [turn.id]
    );

    let approval = null;
    if (rows.length > 0) {
      const a = rows[0];
      const open = a.status === 'requested' || a.status === 'approved';
      const inFlight = open ? await b2cInFlight(db, turn.id) : false;
      approval = {
        id: a.id,
        status: a.status,
        amount: Number(a.amount),
        requestedBy: a.requested_by,
        requestedByName: await nameOf(a.requested_by),
        decidedBy: a.decided_by,
        decidedByName: await nameOf(a.decided_by),
        requestedAt: a.requested_at,
        decidedAt: a.decided_at,
        outdated: open && !sameMoney(a.amount, amount),
        canDecide:
          a.status === 'requested' &&
          isApprover(role) &&
          Number(a.requested_by) !== userId &&
          Number(a.recipient_id) !== userId &&
          !base.paused,
        canCancel: open && isApprover(role) && !inFlight
      };
    }

    res.json({
      ...base,
      turn: { rotationId: turn.id, recipientId: turn.user_id, recipientName, amount },
      approval
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};