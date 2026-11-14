// controllers/meetingController.js
// The secretary's tools. Secretary (and chair) schedule meetings, mark attendance and write the minutes.
// Every member can read them and send an apology. Nobody here can move money or approve anything.

const db = require('../config/db');
const { RequestError } = require('../utils/idempotency');
const { logActivity } = require('../utils/activityLogService');
const { createNotification } = require('./notificationController');

const ATTENDANCE = ['present', 'apology', 'absent'];
const MARK_FROM_HOURS_BEFORE = 12; // attendance and minutes can be recorded from half a day before the meeting
const MAX_MINUTES_LENGTH = 20000;

const canRecord = (role) => role === 'secretary' || role === 'chair';

async function getMembership(groupId, userId, executor = db) {
  const [rows] = await executor.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

function sendError(res, err) {
  if (err instanceof RequestError) return res.status(err.status).json({ success: false, message: err.message });
  return res.status(500).json({ success: false, error: err.message });
}

const when = (d) =>
  new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

// Tell every member except one person; a notification hiccup must never fail the request
async function tellMembers(groupId, exceptUserId, title, message) {
  try {
    const [members] = await db.query('SELECT user_id FROM group_members WHERE group_id = ?', [groupId]);
    for (const m of members) {
      if (Number(m.user_id) === Number(exceptUserId)) continue;
      try {
        await createNotification(m.user_id, title, message);
      } catch (err) {
        console.log('Meeting notification failed:', err.message);
      }
    }
  } catch (err) {
    console.log('Meeting notification failed:', err.message);
  }
}

async function logSafely(entry) {
  try {
    await logActivity(entry);
  } catch (err) {
    console.log('Activity log failed:', err.message);
  }
}

// Loads a meeting and the caller's role in its group, or throws
async function loadMeeting(meetingId, userId, executor = db, forUpdate = false) {
  const [rows] = await executor.query(`SELECT * FROM meetings WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [meetingId]);
  if (rows.length === 0) throw new RequestError(404, 'Meeting not found');
  const meeting = rows[0];
  const role = await getMembership(meeting.group_id, userId, executor);
  if (!role) throw new RequestError(403, 'You are not a member of this group');
  return { meeting, role };
}

function cleanText(value, max, label, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new RequestError(400, `${label} is required`);
  if (text.length > max) throw new RequestError(400, `${label} can be at most ${max} characters`);
  return text || null;
}

function parseDate(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new RequestError(400, 'Choose a valid date and time');
  return d;
}

const shape = (m) => ({
  id: m.id,
  title: m.title,
  meetingDate: m.meeting_date,
  venue: m.venue,
  agenda: m.agenda,
  minutes: m.minutes,
  minutesUpdatedAt: m.minutes_updated_at,
  status: m.status
});

// POST /api/meetings   { group_id, title, meeting_date, venue?, agenda? }
exports.create = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { group_id } = req.body;
    if (!group_id) return res.status(400).json({ success: false, message: 'group_id is required' });

    const role = await getMembership(group_id, userId);
    if (!role) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    if (!canRecord(role)) {
      return res.status(403).json({ success: false, message: 'Only the secretary or chair can schedule meetings' });
    }

    const title = cleanText(req.body.title, 120, 'Title', { required: true });
    const venue = cleanText(req.body.venue, 150, 'Venue');
    const agenda = cleanText(req.body.agenda, 2000, 'Agenda');
    const date = parseDate(req.body.meeting_date);
    if (date.getTime() < Date.now() - 5 * 60 * 1000) {
      return res.status(400).json({ success: false, message: 'The meeting time must be in the future' });
    }

    const [ins] = await db.query(
      'INSERT INTO meetings (group_id, title, meeting_date, venue, agenda, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [group_id, title, date, venue, agenda, userId]
    );

    await tellMembers(group_id, userId, 'New Meeting', `${title}: ${when(date)}${venue ? ` at ${venue}` : ''}.`);
    await logSafely({ userId, groupId: group_id, actionType: 'meeting_scheduled', description: `You scheduled "${title}" for ${when(date)}` });

    res.status(201).json({ success: true, message: 'Meeting scheduled', meetingId: ins.insertId });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/meetings/group/:groupId   upcoming first (soonest first), then past meetings (latest first)
exports.listForGroup = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { groupId } = req.params;

    const role = await getMembership(groupId, userId);
    if (!role) return res.status(403).json({ success: false, message: 'You are not a member of this group' });

    const [meetings] = await db.query('SELECT * FROM meetings WHERE group_id = ? ORDER BY meeting_date DESC LIMIT 200', [groupId]);
    const [attendance] = await db.query(
      'SELECT a.meeting_id, a.user_id, a.status FROM meeting_attendance a JOIN meetings m ON m.id = a.meeting_id WHERE m.group_id = ?',
      [groupId]
    );

    const counts = {};
    const mine = {};
    attendance.forEach((a) => {
      counts[a.meeting_id] = counts[a.meeting_id] || { present: 0, apology: 0, absent: 0 };
      counts[a.meeting_id][a.status] += 1;
      if (Number(a.user_id) === userId) mine[a.meeting_id] = a.status;
    });

    const now = Date.now();
    const all = meetings.map((m) => ({
      ...shape(m),
      hasMinutes: !!(m.minutes && m.minutes.trim()),
      minutes: undefined, // the list stays light; the full minutes come with the meeting itself
      counts: counts[m.id] || { present: 0, apology: 0, absent: 0 },
      myStatus: mine[m.id] || null
    }));
    const upcoming = all
      .filter((m) => m.status === 'scheduled' && new Date(m.meetingDate).getTime() >= now - 3 * 60 * 60 * 1000)
      .sort((a, b) => new Date(a.meetingDate).getTime() - new Date(b.meetingDate).getTime());
    const upcomingIds = new Set(upcoming.map((m) => m.id));
    const past = all.filter((m) => !upcomingIds.has(m.id)); // already newest first

    res.json({ success: true, canRecord: canRecord(role), upcoming, past });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/meetings/:id   the full meeting: minutes and who attended
exports.getOne = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { meeting, role } = await loadMeeting(req.params.id, userId);

    const [members] = await db.query(
      'SELECT u.id, u.full_name, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.full_name',
      [meeting.group_id]
    );
    const [attendance] = await db.query('SELECT user_id, status, reason FROM meeting_attendance WHERE meeting_id = ?', [meeting.id]);
    const byUser = {};
    const reasonOf = {};
    attendance.forEach((a) => {
      byUser[a.user_id] = a.status;
      reasonOf[a.user_id] = a.reason || null;
    });

    res.json({
      success: true,
      canRecord: canRecord(role),
      meeting: shape(meeting),
      attendance: members.map((m) => ({ userId: m.id, name: m.full_name, role: m.role, status: byUser[m.id] || null, reason: canRecord(role) || m.id === userId ? reasonOf[m.id] || null : null }))
    });
  } catch (err) {
    sendError(res, err);
  }
};

// PATCH /api/meetings/:id   { title?, meeting_date?, venue?, agenda?, status?: 'cancelled' }   (scheduled meetings only)
exports.update = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { meeting, role } = await loadMeeting(req.params.id, userId);
    if (!canRecord(role)) {
      return res.status(403).json({ success: false, message: 'Only the secretary or chair can change meetings' });
    }
    if (meeting.status !== 'scheduled') {
      return res.status(409).json({ success: false, message: `A ${meeting.status} meeting cannot be changed` });
    }

    if (req.body.status !== undefined) {
      if (req.body.status !== 'cancelled') {
        return res.status(400).json({ success: false, message: 'The only status you can set is cancelled' });
      }
      await db.query(`UPDATE meetings SET status = 'cancelled' WHERE id = ?`, [meeting.id]);
      await tellMembers(meeting.group_id, userId, 'Meeting Cancelled', `"${meeting.title}" on ${when(meeting.meeting_date)} was cancelled.`);
      await logSafely({ userId, groupId: meeting.group_id, actionType: 'meeting_scheduled', description: `You cancelled "${meeting.title}"` });
      return res.json({ success: true, message: 'Meeting cancelled' });
    }

    const title = req.body.title !== undefined ? cleanText(req.body.title, 120, 'Title', { required: true }) : meeting.title;
    const venue = req.body.venue !== undefined ? cleanText(req.body.venue, 150, 'Venue') : meeting.venue;
    const agenda = req.body.agenda !== undefined ? cleanText(req.body.agenda, 2000, 'Agenda') : meeting.agenda;
    const date = req.body.meeting_date !== undefined ? parseDate(req.body.meeting_date) : new Date(meeting.meeting_date);
    if (req.body.meeting_date !== undefined && date.getTime() < Date.now() - 5 * 60 * 1000) {
      return res.status(400).json({ success: false, message: 'The meeting time must be in the future' });
    }

    const timeOrPlaceChanged =
      date.getTime() !== new Date(meeting.meeting_date).getTime() || (venue || null) !== (meeting.venue || null) || title !== meeting.title;
    const anythingChanged = timeOrPlaceChanged || (agenda || null) !== (meeting.agenda || null);
    if (!anythingChanged) return res.status(400).json({ success: false, message: 'Nothing to change' });

    await db.query('UPDATE meetings SET title = ?, meeting_date = ?, venue = ?, agenda = ? WHERE id = ?', [title, date, venue, agenda, meeting.id]);
    if (timeOrPlaceChanged) {
      await tellMembers(meeting.group_id, userId, 'Meeting Updated', `${title}: now ${when(date)}${venue ? ` at ${venue}` : ''}.`);
    }

    res.json({ success: true, message: 'Meeting updated' });
  } catch (err) {
    sendError(res, err);
  }
};

function assertCanRecordNow(meeting) {
  if (meeting.status === 'cancelled') throw new RequestError(409, 'This meeting was cancelled');
  const earliest = new Date(meeting.meeting_date).getTime() - MARK_FROM_HOURS_BEFORE * 60 * 60 * 1000;
  if (Date.now() < earliest) {
    throw new RequestError(409, 'This can be recorded from the day of the meeting');
  }
}

// PUT /api/meetings/:id/attendance   { records: [{ user_id, status: 'present' | 'apology' | 'absent' | 'none' }] }
exports.saveAttendance = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const records = req.body.records;
    if (!Array.isArray(records) || records.length === 0 || records.length > 500) {
      return res.status(400).json({ success: false, message: 'Send the attendance as a list' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const { meeting, role } = await loadMeeting(req.params.id, userId, conn, true);
      if (!canRecord(role)) throw new RequestError(403, 'Only the secretary or chair can mark attendance');
      assertCanRecordNow(meeting);

      for (const r of records) {
        const memberId = Number(r.user_id);
        if (!memberId || (r.status !== 'none' && !ATTENDANCE.includes(r.status))) {
          throw new RequestError(400, 'Each entry needs a member and present, apology, absent or none');
        }
        if (!(await getMembership(meeting.group_id, memberId, conn))) {
          throw new RequestError(400, 'One of those people is not a member of this group');
        }
        if (r.status === 'none') {
          await conn.query('DELETE FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?', [meeting.id, memberId]);
        } else {
          await conn.query(
            'INSERT INTO meeting_attendance (meeting_id, user_id, status, marked_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = IF(VALUES(status) = \'apology\', reason, NULL), status = VALUES(status), marked_by = VALUES(marked_by)',
            [meeting.id, memberId, r.status, userId]
          );
        }
      }
      if (meeting.status === 'scheduled') await conn.query(`UPDATE meetings SET status = 'held' WHERE id = ?`, [meeting.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: 'Attendance saved' });
  } catch (err) {
    sendError(res, err);
  }
};

// PUT /api/meetings/:id/minutes   { minutes }
exports.saveMinutes = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { meeting, role } = await loadMeeting(req.params.id, userId);
    if (!canRecord(role)) {
      return res.status(403).json({ success: false, message: 'Only the secretary or chair can write the minutes' });
    }
    assertCanRecordNow(meeting);

    const minutes = typeof req.body.minutes === 'string' ? req.body.minutes.trim() : '';
    if (minutes.length > MAX_MINUTES_LENGTH) {
      return res.status(400).json({ success: false, message: `The minutes can be at most ${MAX_MINUTES_LENGTH} characters` });
    }

    await db.query(
      `UPDATE meetings SET minutes = ?, minutes_updated_at = NOW(), status = IF(status = 'scheduled', 'held', status) WHERE id = ?`,
      [minutes || null, meeting.id]
    );

    const firstTime = !(meeting.minutes && meeting.minutes.trim()) && !!minutes;
    if (firstTime) {
      await tellMembers(meeting.group_id, userId, 'Minutes Posted', `The minutes of "${meeting.title}" are now available.`);
      await logSafely({ userId, groupId: meeting.group_id, actionType: 'minutes_posted', description: `You posted the minutes of "${meeting.title}"` });
    }

    res.json({ success: true, message: 'Minutes saved' });
  } catch (err) {
    sendError(res, err);
  }
};

// POST /api/meetings/:id/apology   { on: true | false }   a member tells the group they can't come
exports.apology = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const { meeting } = await loadMeeting(req.params.id, userId);
    if (meeting.status !== 'scheduled' || new Date(meeting.meeting_date).getTime() < Date.now()) {
      return res.status(409).json({ success: false, message: 'You can only send an apology before the meeting' });
    }

    if (req.body.on === false) {
      await db.query(`DELETE FROM meeting_attendance WHERE meeting_id = ? AND user_id = ? AND status = 'apology'`, [meeting.id, userId]);
      return res.json({ success: true, message: 'Apology withdrawn' });
    }

    const reason = String(req.body.reason || '').trim();
    if (reason.length > 255) return res.status(400).json({ success: false, message: 'Keep the reason under 255 characters' });

    await db.query(
      `INSERT INTO meeting_attendance (meeting_id, user_id, status, marked_by, reason) VALUES (?, ?, 'apology', ?, ?) ON DUPLICATE KEY UPDATE status = 'apology', marked_by = VALUES(marked_by), reason = VALUES(reason)`,
      [meeting.id, userId, userId, reason || null]
    );
    res.json({ success: true, message: 'Apology sent' });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/meetings/upcoming  -> the next few scheduled meetings across all my groups (for the Home screen)
exports.upcomingForMe = async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await db.query(
      `SELECT m.*, g.name AS group_name
       FROM meetings m
       JOIN group_members gm ON gm.group_id = m.group_id
       JOIN groups_table g ON g.id = m.group_id
       WHERE gm.user_id = ? AND m.status = 'scheduled'
       ORDER BY m.meeting_date ASC LIMIT 100`,
      [userId]
    );
    const [apologies] = await db.query(`SELECT meeting_id FROM meeting_attendance WHERE user_id = ? AND status = 'apology'`, [userId]);
    const apologised = new Set(apologies.map((a) => Number(a.meeting_id)));

    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    const meetings = rows
      .filter((m) => new Date(m.meeting_date).getTime() >= cutoff)
      .slice(0, 5)
      .map((m) => ({
        id: m.id,
        groupId: m.group_id,
        groupName: m.group_name,
        title: m.title,
        meetingDate: m.meeting_date,
        venue: m.venue,
        apologySent: apologised.has(Number(m.id))
      }));

    res.json({ success: true, meetings });
  } catch (err) {
    sendError(res, err);
  }
};