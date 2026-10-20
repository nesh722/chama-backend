const db = require('../config/db');
const { Expo } = require('expo-server-sdk');

const expo = new Expo();

// Helper: a user's role in a group (null if not a member)
async function getMembership(groupId, userId) {
  const [rows] = await db.query(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0].role : null;
}

// Helper: create a notification (used internally by other controllers too)
async function createNotification(userId, title, message) {
  await db.query(
    'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
    [userId, title, message]
  );

  // Also send a push notification, if this user has a registered device
  try {
    const [rows] = await db.query('SELECT push_token FROM users WHERE id = ?', [userId]);
    const token = rows[0]?.push_token;

            if (token && Expo.isExpoPushToken(token)) {
      const tickets = await expo.sendPushNotificationsAsync([
        { to: token, sound: 'default', title, body: message }
      ]);
      tickets.forEach((t) => {
        if (t.status === 'error') console.log('Push rejected:', t.message, t.details);
        else console.log('Push accepted by Expo for user', userId);
      });
    } else {
      console.log('No valid push token for user', userId);
    }
  } catch (pushErr) {
    // Push failures shouldn't break the in-app notification -- just log it
    console.log('Push notification failed:', pushErr.message);
  }
}

// GET MY NOTIFICATIONS
exports.getMyNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [rows] = await db.query(
      'SELECT id, title, message, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json({ success: true, notifications: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// MARK A NOTIFICATION AS READ
exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const [rows] = await db.query('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    await db.query('UPDATE notifications SET is_read = TRUE WHERE id = ?', [id]);
    res.json({ success: true, message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// MANUALLY SEND A NOTIFICATION (a treasurer/chair reminding a member of their own group)
exports.sendNotification = async (req, res) => {
  try {
    const { group_id, user_id, title, message } = req.body;
    const senderId = req.user.userId;

    if (!group_id || !user_id || !title || !message) {
      return res.status(400).json({ success: false, message: 'group_id, user_id, title, and message are required' });
    }

    const cleanTitle = String(title).trim();
    const cleanMessage = String(message).trim();
    if (!cleanTitle || !cleanMessage) {
      return res.status(400).json({ success: false, message: 'Title and message cannot be empty' });
    }
    if (cleanTitle.length > 100 || cleanMessage.length > 500) {
      return res.status(400).json({ success: false, message: 'Title must be under 100 characters and message under 500' });
    }

    // Sender must be treasurer/chair of this group
    const senderRole = await getMembership(group_id, senderId);
    if (senderRole !== 'treasurer' && senderRole !== 'chair') {
      return res.status(403).json({ success: false, message: 'Only the treasurer or chair can send notifications to members' });
    }

    // Recipient must belong to the same group
    const recipientRole = await getMembership(group_id, user_id);
    if (!recipientRole) {
      return res.status(400).json({ success: false, message: 'That user is not a member of this group' });
    }

    // Prefix the group name, so the recipient can see where the message came from
    const [groupRows] = await db.query('SELECT name FROM groups_table WHERE id = ?', [group_id]);
    const groupName = groupRows[0]?.name || 'Your group';

    await createNotification(user_id, `${groupName}: ${cleanTitle}`, cleanMessage);
    res.status(201).json({ success: true, message: 'Notification sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// CLEAR ALL MY NOTIFICATIONS
exports.clearAllNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;

    await db.query('DELETE FROM notifications WHERE user_id = ?', [userId]);

    res.json({ success: true, message: 'All notifications cleared' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.createNotification = createNotification; // exported so other controllers can reuse it later