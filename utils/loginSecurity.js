// Account lockout after repeated wrong passwords, and one-time email codes for two-step login.
// Every time is judged by the database clock (NOW()), so server and database time zones never disagree.
const crypto = require('crypto');
const db = require('../config/db');

const MAX_FAILED_LOGINS = 5;          // wrong passwords in a row before the account locks
const LOCK_MINUTES = [15, 60, 1440];  // 1st lock 15 min, 2nd 1 hour, 3rd and later 24 hours
const CODE_MINUTES = 10;              // how long an emailed code stays valid
const MAX_CODE_GUESSES = 5;           // wrong guesses before a code is thrown away
const MAX_CODES_PER_WINDOW = 5;       // codes that may be sent to one person per 15 minutes

// ---------- lockout ----------

// Is this user locked right now? Returns minutes left (rounded up), or 0.
function minutesLocked(user) {
  if (!user || !user.is_locked) return 0;
  return Math.max(1, Number(user.minutes_left) || 1);
}

// A wrong password. Counts it, and locks the account when the limit is reached.
// Returns { locked, minutes, attemptsLeft }.
async function registerFailedLogin(userId) {
  await db.query('UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?', [userId]);
  const [rows] = await db.query('SELECT failed_login_attempts, lockout_count FROM users WHERE id = ?', [userId]);
  const attempts = Number(rows[0].failed_login_attempts);

  if (attempts >= MAX_FAILED_LOGINS) {
    const minutes = LOCK_MINUTES[Math.min(Number(rows[0].lockout_count), LOCK_MINUTES.length - 1)];
    await db.query(
      `UPDATE users
       SET locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE), failed_login_attempts = 0, lockout_count = lockout_count + 1
       WHERE id = ?`,
      [minutes, userId]
    );
    return { locked: true, minutes, attemptsLeft: 0 };
  }
  return { locked: false, minutes: 0, attemptsLeft: MAX_FAILED_LOGINS - attempts };
}

// A correct password (or a successful reset): forget the failures and any lock.
async function clearLoginFailures(userId) {
  await db.query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, lockout_count = 0 WHERE id = ?',
    [userId]
  );
}

// ---------- emailed codes ----------

function hashCode(userId, purpose, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${userId}:${purpose}:${code}`).digest('hex');
}

// Makes a new code and throws away older unused ones of the same purpose.
// Returns { code } or { tooMany: true } when too many were requested recently.
async function createCode(userId, purpose) {
  const [recent] = await db.query(
    `SELECT COUNT(*) AS n FROM login_codes
     WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
    [userId]
  );
  if (Number(recent[0].n) >= MAX_CODES_PER_WINDOW) return { tooMany: true };

  await db.query('UPDATE login_codes SET used = 1 WHERE user_id = ? AND purpose = ? AND used = 0', [userId, purpose]);
  const code = String(crypto.randomInt(100000, 1000000));
  await db.query(
    `INSERT INTO login_codes (user_id, purpose, code_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${CODE_MINUTES} MINUTE))`,
    [userId, purpose, hashCode(userId, purpose, code)]
  );
  return { code };
}

// Checks a typed code. Returns { ok: true } or { ok: false, message, status }.
async function checkCode(userId, purpose, typed) {
  const clean = String(typed || '').replace(/\D/g, '');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, code_hash, attempts FROM login_codes
       WHERE user_id = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [userId, purpose]
    );
    if (rows.length === 0) {
      await conn.commit();
      return { ok: false, status: 400, message: 'That code has expired. Request a new one.' };
    }
    const row = rows[0];

    const expected = Buffer.from(row.code_hash);
    const given = Buffer.from(hashCode(userId, purpose, clean));
    const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);

    if (match) {
      await conn.query('UPDATE login_codes SET used = 1 WHERE id = ?', [row.id]);
      await conn.commit();
      return { ok: true };
    }

    const attempts = Number(row.attempts) + 1;
    const dead = attempts >= MAX_CODE_GUESSES;
    await conn.query('UPDATE login_codes SET attempts = ?, used = ? WHERE id = ?', [attempts, dead ? 1 : 0, row.id]);
    await conn.commit();
    return {
      ok: false,
      status: 400,
      message: dead
        ? 'Too many wrong codes. Request a new code.'
        : `Wrong code. ${MAX_CODE_GUESSES - attempts} attempt(s) left.`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Treasurers and chairs (of any group) must use two-step login
async function isApprover(userId) {
  const [rows] = await db.query(
    `SELECT 1 FROM group_members WHERE user_id = ? AND role IN ('treasurer', 'chair') LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return email;
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

module.exports = {
  MAX_FAILED_LOGINS, CODE_MINUTES,
  minutesLocked, registerFailedLogin, clearLoginFailures,
  createCode, checkCode, isApprover, maskEmail
};
