const db = require('../config/db');

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const validKey = (key) =>
  key === undefined || (typeof key === 'string' && key.length >= 8 && key.length <= 64);

async function claimKey(key, userId, endpoint) {
  try {
    await db.query(
      'INSERT INTO request_keys (idempotency_key, user_id, endpoint) VALUES (?, ?, ?)',
      [key, userId, endpoint]
    );
    return { status: 'new' };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const [rows] = await db.query(
      'SELECT response_json FROM request_keys WHERE idempotency_key = ? AND user_id = ?',
      [key, userId]
    );
    if (rows[0]?.response_json) {
      return { status: 'done', response: JSON.parse(rows[0].response_json) };
    }
    return { status: 'in_progress' };
  }
}

async function saveResponse(key, userId, response) {
  await db.query(
    'UPDATE request_keys SET response_json = ? WHERE idempotency_key = ? AND user_id = ?',
    [JSON.stringify(response), key, userId]
  );
}

async function releaseKey(key, userId) {
  await db.query(
    'DELETE FROM request_keys WHERE idempotency_key = ? AND user_id = ? AND response_json IS NULL',
    [key, userId]
  );
}

// Runs `work(conn)` inside one database transaction, once per idempotency key.
// A retry of something that already succeeded gets the saved result back.
async function runOnce({ key, userId, endpoint }, work) {
  let claimed = false;
  if (key) {
    const claim = await claimKey(key, userId, endpoint);
    if (claim.status === 'done') return { replayed: true, payload: claim.response };
    if (claim.status === 'in_progress') {
      throw new RequestError(409, 'This request is already being processed. Please wait a moment.');
    }
    claimed = true;
  }

  const conn = await db.getConnection();
  let payload;
  try {
    await conn.beginTransaction();
    payload = await work(conn);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (claimed) await releaseKey(key, userId); // nothing was saved, so a retry may go ahead
    throw err;
  } finally {
    conn.release();
  }

  if (claimed) {
    try {
      await saveResponse(key, userId, payload);
    } catch (err) {
      console.log('Saving idempotency response failed:', err.message);
    }
  }
  return { replayed: false, payload };
}

module.exports = { claimKey, saveResponse, releaseKey, runOnce, RequestError, validKey };