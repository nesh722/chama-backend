// Group notices. Secretary (and chair) post them, every member reads them and gets a notification.

const db = require('../config/db');
const { RequestError } = require('../utils/idempotency');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');

const canPost = (role) => role === 'secretary' || role === 'chair';

async function getMembership(groupId, userId) {
  const [rows] = await db.query('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows.length > 0 ? rows[0].role : null;
}

function sendError(res, err) {
  if (err instanceof RequestError) return res.status(err.status).json({ success: false, message: err.message });
  return res.status(500).json({ success: false, error: err.message });
}

// POST /api/announcements   { group_id, title, body }
exports.create = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { group_id } = req.body;
    if (!group_id) return res.status(400).json({ success: false, message: 'group_id is required' });

    const role = await getMembership(group_id, userId);
    if (!role) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    if (!canPost(role)) {
      return res.status(403).json({ success: false, message: 'Only the secretary or chair can post notices' });
    }

    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });
    if (title.length > 120) return res.status(400).json({ success: false, message: 'Title can be at most 120 characters' });
    if (!body) return res.status(400).json({ success: false, message: 'Write the notice' });
    if (body.length > 2000) return res.status(400).json({ success: false, message: 'The notice can be at most 2000 characters' });

    const [ins] = await db.query('INSERT INTO announcements (group_id, title, body, created_by) VALUES (?, ?, ?, ?)', [group_id, title, body, userId]);

    try {
      const [g] = await db.query('SELECT name FROM groups_table WHERE id = ?', [group_id]);
      const [members] = await db.query('SELECT user_id FROM group_members WHERE group_id = ?', [group_id]);
      for (const m of members) {
        if (Number(m.user_id) === userId) continue;
        try {
          await createNotification(m.user_id, `Notice: ${title}`, `${g[0] ? g[0].name + ': ' : ''}${body.length > 140 ? body.slice(0, 137) + '...' : body}`);
        } catch (err) {
          console.log('Notice notification failed:', err.message);
        }
      }
      await logActivity({ userId, groupId: group_id, actionType: 'announcement_posted', description: `You posted the notice "${title}"` });
    } catch (err) {
      console.log('Notice follow-up failed:', err.message);
    }

    res.status(201).json({ success: true, message: 'Notice posted', announcementId: ins.insertId });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/announcements/group/:groupId   latest first
exports.listForGroup = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { groupId } = req.params;

    const role = await getMembership(groupId, userId);
    if (!role) return res.status(403).json({ success: false, message: 'You are not a member of this group' });

    const [rows] = await db.query(
      `SELECT a.id, a.title, a.body, a.created_at, u.full_name AS author_name
       FROM announcements a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.group_id = ?
       ORDER BY a.id DESC
       LIMIT 30`,
      [groupId]
    );

    res.json({
      success: true,
      canPost: canPost(role),
      announcements: rows.map((a) => ({ id: a.id, title: a.title, body: a.body, authorName: a.author_name, createdAt: a.created_at }))
    });
  } catch (err) {
    sendError(res, err);
  }
};

// DELETE /api/announcements/:id
exports.remove = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await db.query('SELECT id, group_id FROM announcements WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Notice not found' });

    const role = await getMembership(rows[0].group_id, userId);
    if (!canPost(role)) {
      return res.status(403).json({ success: false, message: 'Only the secretary or chair can remove notices' });
    }

    await db.query('DELETE FROM announcements WHERE id = ?', [rows[0].id]);
    res.json({ success: true, message: 'Notice removed' });
  } catch (err) {
    sendError(res, err);
  }
};