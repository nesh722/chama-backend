const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('../utils/emailService');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/avatars/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `user_${req.user.userId}_${Date.now()}${ext}`);
  }
});
exports.uploadMiddleware = multer({ storage }).single('avatar');

exports.uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await db.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.userId]);
    res.json({ success: true, avatar_url: avatarUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// REGISTER
exports.register = async (req, res) => {
  try {
    const { full_name, email, phone, password } = req.body;

    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address' });
    }

    const digitsOnly = phone.replace(/\D/g, '');
    if (digitsOnly.length !== 10) {
      return res.status(400).json({ success: false, message: 'Phone number must be exactly 10 digits' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    // Check if user already exists
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ? OR phone = ?',
      [email, phone]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Email or phone already registered' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert user
    const [result] = await db.query(
      'INSERT INTO users (full_name, email, phone, password_hash) VALUES (?, ?, ?, ?)',
      [full_name, email.trim(), digitsOnly, password_hash]
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      userId: result.insertId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// LOGIN
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET LOGGED-IN USER'S PROFILE
exports.getProfile = async (req, res) => {
  try {
    const [rows] = await db.query(
     'SELECT id, full_name, email, phone, avatar_url, created_at FROM users WHERE id = ?',
      [req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// REQUEST PASSWORD RESET
exports.requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const [users] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      // Don't reveal whether the email exists — respond the same either way
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent' });
    }

    const userId = users[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await db.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)',
      [userId, token, expiresAt]
    );

        await sendPasswordResetEmail(email, token);

    res.json({ success: true, message: 'If that email exists, a reset code has been sent to it.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// RESET PASSWORD USING TOKEN
exports.resetPassword = async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ success: false, message: 'Token and new_password are required' });
    }

    const [resets] = await db.query(
      'SELECT * FROM password_resets WHERE token = ? AND used = FALSE AND expires_at > NOW()',
      [token]
    );
    if (resets.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    const reset = resets[0];
    const password_hash = await bcrypt.hash(new_password, 10);

    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, reset.user_id]);
    await db.query('UPDATE password_resets SET used = TRUE WHERE id = ?', [reset.id]);

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// UPDATE BASIC PROFILE INFO (name, phone)
exports.updateProfile = async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    const userId = req.user.userId;

    if (!full_name || !phone) {
      return res.status(400).json({ success: false, message: 'Full name and phone are required' });
    }

    await db.query('UPDATE users SET full_name = ?, phone = ? WHERE id = ?', [full_name, phone, userId]);

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// CHANGE EMAIL (requires current password)
exports.changeEmail = async (req, res) => {
  try {
    const { current_password, new_email } = req.body;
    const userId = req.user.userId;

    if (!current_password || !new_email) {
      return res.status(400).json({ success: false, message: 'Current password and new email are required' });
    }

    const [users] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, users[0].password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const [existing] = await db.query('SELECT id FROM users WHERE email = ? AND id != ?', [new_email, userId]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'That email is already in use' });
    }

    await db.query('UPDATE users SET email = ? WHERE id = ?', [new_email, userId]);

    res.json({ success: true, message: 'Email updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// CHANGE PASSWORD (requires current password)
exports.changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user.userId;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Current and new password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const [users] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, users[0].password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Rule 1: no outstanding loans as borrower
    const [outstandingLoans] = await db.query(
      `SELECT COUNT(*) AS count FROM loans WHERE user_id = ? AND status IN ('requested', 'approved')`,
      [userId]
    );
    if (outstandingLoans[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'You have outstanding loans that must be repaid or resolved before deleting your account'
      });
    }

    // Rule 2: not the last treasurer/chair in any group you belong to
    const [myApproverGroups] = await db.query(
      `SELECT group_id FROM group_members WHERE user_id = ? AND role IN ('treasurer', 'chair')`,
      [userId]
    );
    for (const row of myApproverGroups) {
      const [approverCount] = await db.query(
        `SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND role IN ('treasurer', 'chair')`,
        [row.group_id]
      );
      if (approverCount[0].count <= 1) {
        return res.status(400).json({
          success: false,
          message: 'You are the only treasurer/chair in at least one group — assign another approver there before deleting your account'
        });
      }
    }

    // Rule 3: not the creator of any existing group
    const [createdGroups] = await db.query('SELECT COUNT(*) AS count FROM groups_table WHERE created_by = ?', [userId]);
    if (createdGroups[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'You created at least one group that still exists — delete or transfer it before deleting your account'
      });
    }

    // Detach from historical loan-approval references (not blocking, just informational)
    await db.query('UPDATE loans SET approved_by = NULL WHERE approved_by = ?', [userId]);

    // Actually delete the account — group_members, contributions, notifications, password_resets
    // all cascade automatically via their foreign keys
    await db.query('DELETE FROM users WHERE id = ?', [userId]);

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// SAVE/UPDATE THIS DEVICE'S PUSH TOKEN
exports.savePushToken = async (req, res) => {
  try {
    const { push_token } = req.body;
    const userId = req.user.userId;

    if (!push_token) {
      return res.status(400).json({ success: false, message: 'push_token is required' });
    }

    await db.query('UPDATE users SET push_token = ? WHERE id = ?', [push_token, userId]);
    res.json({ success: true, message: 'Push token saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};