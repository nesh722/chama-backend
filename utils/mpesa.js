// utils/mpesa.js
// Thin client for Safaricom Daraja: M-Pesa Express (STK Push).
// Uses Node's built-in fetch (Node 18+), so no extra dependency is needed.

const BASE_URL =
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

let cachedToken = null;
let tokenExpiresAt = 0;

function assertConfig() {
  const missing = [
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_SHORTCODE',
    'MPESA_PASSKEY',
    'MPESA_CALLBACK_URL'
  ].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`M-Pesa is not configured. Missing in .env: ${missing.join(', ')}`);
  }
}

// OAuth token, cached until shortly before it expires (Daraja tokens last ~1 hour)
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  if (!res.ok) {
    throw new Error(`Could not get M-Pesa access token (HTTP ${res.status}). Check your consumer key and secret.`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in || 3599) - 60) * 1000;
  return cachedToken;
}

// Daraja wants YYYYMMDDHHmmss in East Africa Time
function timestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}${get('month')}${get('day')}${hour}${get('minute')}${get('second')}`;
}

function buildPassword(ts) {
  return Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`
  ).toString('base64');
}

// 0712345678 / 0112345678 / +254712345678 / 254712345678 / 712345678  ->  254712345678
// Returns null if the number can't be a valid Kenyan mobile number.
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let phone = null;
  if (/^0[17]\d{8}$/.test(digits)) phone = `254${digits.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(digits)) phone = digits;
  else if (/^[17]\d{8}$/.test(digits)) phone = `254${digits}`;
  return phone;
}

// Sends the PIN prompt to the customer's phone.
// Returns Daraja's response: { MerchantRequestID, CheckoutRequestID, ResponseCode, ... }
async function stkPush({ phone, amount, accountReference, description }) {
  assertConfig();

  const wholeAmount = Math.round(Number(amount));
  if (!wholeAmount || wholeAmount < 1) {
    throw new Error('M-Pesa amount must be at least KES 1');
  }

  const token = await getAccessToken();
  const ts = timestamp();

  const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: buildPassword(ts),
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: wholeAmount,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: String(accountReference || 'Chama').slice(0, 12),
      TransactionDesc: String(description || 'Chama payment').slice(0, 13)
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.CustomerMessage || data.ResponseDescription || 'M-Pesa request failed');
  }
  return data;
}

// Asks Daraja for the outcome of a push. This is the fallback for when the callback never arrives.
// Returns { pending: true } while Safaricom is still processing, otherwise { resultCode, resultDesc }.
async function stkQuery(checkoutRequestId) {
  assertConfig();

  const token = await getAccessToken();
  const ts = timestamp();

  const res = await fetch(`${BASE_URL}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: buildPassword(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId
    })
  });

  const data = await res.json().catch(() => ({}));

  // While the customer hasn't finished yet, Daraja replies with an error body instead of a result,
  // or with result code 4999 ("The transaction is still under processing"). Neither is final.
  if (data.ResultCode === undefined || Number(data.ResultCode) === 4999) {
    return { pending: true, raw: data };
  }
  return {
    pending: false,
    resultCode: Number(data.ResultCode),
    resultDesc: data.ResultDesc || '',
    raw: data
  };
}

// Flattens the callback Safaricom POSTs to your server.
function parseCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return null;

  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const meta = {};
  items.forEach((i) => {
    meta[i.Name] = i.Value;
  });

  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: cb.ResultDesc || '',
    receipt: meta.MpesaReceiptNumber || null,
    amount: meta.Amount !== undefined ? Number(meta.Amount) : null,
    phone: meta.PhoneNumber ? String(meta.PhoneNumber) : null
  };
}

module.exports = { stkPush, stkQuery, parseCallback, normalizePhone };