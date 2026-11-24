// controllers/twoFactorController.js
// Two-step login by emailed code: finishing a login, resending the code, switching it on and off.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const {
  CODE_MINUTES, minutesLocked, registerFailedLogin, clearLoginFailures,
  createCode, checkCode, isApprover, maskEmail
} = require('../utils/loginSecurity');
const { sendLoginCode, sendLockoutNotice } = require('../utils/securityMail');

// The challenge token only proves "this person passed the password step". It is signed with a
// different secret from the real login token, so it can never be used to open the app.
const challengeSecret = () => `${process.env.JWT_SECRET}:2fa`;

exports.makeChallengeToken = (userId) =>
  jwt.sign({ userId, purpose: '2fa' }, challengeSecret(), { expiresIn: '10m' });

function readChallenge(token) {
  try {
    const decoded = jwt.verify(String(token || ''), challengeSecret());
    return decoded.purpose === '2fa' ? decoded : null;
  } catch (err) {
    return null;
  }
}

const loadUser = async (id) => {
  const [rows] = await db.query(
    `SELECT *, (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked,
            GREATEST(CEIL(TIMESTAMPDIFF(SECOND, NOW(), locked_until) / 60), 1) AS minutes_left
     FROM users WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
};

// A wrong password on a settings screen counts like a wrong password at login
async function passwordOk(user, password, res) {
  if (!password) {
    res.status(400).json({ success: false, message: 'Enter your password' });
    return false;
  }
  if (await bcrypt.compare(password, user.password_hash)) return true;
  const r = await registerFailedLogin(user.id);
  if (r.locked) {
    try { await sendLockoutNotice(user.email, r.minutes); } catch (e) { console.log('Lockout email failed:', e.message); }
  }
  res.status(r.locked ? 423 : 400).json({
    success: false,
    message: r.locked
      ? `Too many wrong attempts. This account is locked for ${r.minutes} minutes.`
      : 'Password is incorrect'
  });
  return false;
}

async function sendCode(user, purpose, why, res) {
  const made = await createCode(user.id, purpose);
  if (made.tooMany) {
    res.status(429).json({ success: false, message: 'Too many codes requested. Please wait 15 minutes.' });
    return false;
  }
  try {
    await sendLoginCode(user.email, made.code, CODE_MINUTES, why);
  } catch (err) {
    console.log('Login code email failed:', err.message);
    res.status(502).json({ success: false, message: 'Could not send the code to your email. Try again shortly.' });
    return false;
  }
  return true;
}

// POST /api/auth/login/verify   { challenge_token, code }   (no login token yet)
exports.verifyLogin = async (req, res) => {
  try {
    const challenge = readChallenge(req.body.challenge_token);
    if (!challenge) {
      return res.status(401).json({ success: false, expired: true, message: 'This login has expired. Please log in again.' });
    }
    const user = await loadUser(challenge.userId);
    if (!user) return res.status(401).json({ success: false, expired: true, message: 'Please log in again.' });

    const lockedFor = minutesLocked(user);
    if (lockedFor) {
      return res.status(423).json({ success: false, message: `This account is locked for ${lockedFor} more minute(s).` });
    }

    const result = await checkCode(user.id, 'login', req.body.code);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

    await clearLoginFailures(user.id);
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, two_factor_enabled: true }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/auth/login/resend   { challenge_token }
exports.resendLogin = async (req, res) => {
  try {
    const challenge = readChallenge(req.body.challenge_token);
    if (!challenge) {
      return res.status(401).json({ success: false, expired: true, message: 'This login has expired. Please log in again.' });
    }
    const user = await loadUser(challenge.userId);
    if (!user || minutesLocked(user)) {
      return res.status(401).json({ success: false, expired: true, message: 'Please log in again.' });
    }
    if (!(await sendCode(user, 'login', 'logging in', res))) return;
    res.json({ success: true, message: 'A new code was sent', email_hint: maskEmail(user.email) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/auth/2fa/enable/start   { password }   (logged in)
exports.startEnable = async (req, res) => {
  try {
    const user = await loadUser(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.two_factor_enabled) {
      return res.status(409).json({ success: false, message: 'Two-step login is already on' });
    }
    if (!(await passwordOk(user, req.body.password, res))) return;
    if (!(await sendCode(user, 'enable_2fa', 'switching on two-step login', res))) return;
    res.json({ success: true, message: 'We sent a code to your email', email_hint: maskEmail(user.email) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/auth/2fa/enable/confirm   { code }   (logged in)
exports.confirmEnable = async (req, res) => {
  try {
    const result = await checkCode(req.user.userId, 'enable_2fa', req.body.code);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    await db.query('UPDATE users SET two_factor_enabled = 1 WHERE id = ?', [req.user.userId]);
    res.json({ success: true, message: 'Two-step login is on' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/auth/2fa/disable   { password }   (logged in)
exports.disable = async (req, res) => {
  try {
    const user = await loadUser(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.two_factor_enabled) {
      return res.status(409).json({ success: false, message: 'Two-step login is already off' });
    }
    if (await isApprover(user.id)) {
      return res.status(403).json({
        success: false,
        message: 'Treasurers and chairs must keep two-step login on. Hand over the role first if you need to turn it off.'
      });
    }
    if (!(await passwordOk(user, req.body.password, res))) return;
    await db.query('UPDATE users SET two_factor_enabled = 0 WHERE id = ?', [user.id]);
    res.json({ success: true, message: 'Two-step login is off' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
