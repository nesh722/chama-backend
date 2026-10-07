const db = require('../config/db');
const { Expo } = require('expo-server-sdk');

const expo = new Expo();

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
      await expo.sendPushNotificationsAsync([
        { to: token, sound: 'default', title, body: message }
      ]);
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

// MANUALLY CREATE A NOTIFICATION (e.g. treasurer reminding a member)
exports.sendNotification = async (req, res) => {
  try {
    const { user_id, title, message } = req.body;

    if (!user_id || !title || !message) {
      return res.status(400).json({ success: false, message: 'user_id, title, and message are required' });
    }

    await createNotification(user_id, title, message);
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