const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('./mpesa');

const BASE_URL =
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// v1 is what the sandbox documents. If Safaricom moves you to v3, set MPESA_B2C_PATH=/mpesa/b2c/v3/paymentrequest
const B2C_PATH = process.env.MPESA_B2C_PATH || '/mpesa/b2c/v1/paymentrequest';

const tokenCache = new Map(); // consumer key -> { token, expiresAt }

function consumerCredentials() {
  return {
    key: process.env.MPESA_B2C_CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY,
    secret: process.env.MPESA_B2C_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET
  };
}

function assertConfig() {
  const { key, secret } = consumerCredentials();
  const missing = [];
  if (!key) missing.push('MPESA_CONSUMER_KEY');
  if (!secret) missing.push('MPESA_CONSUMER_SECRET');
  [
    'MPESA_B2C_SHORTCODE',
    'MPESA_B2C_INITIATOR_NAME',
    'MPESA_B2C_INITIATOR_PASSWORD',
    'MPESA_B2C_CERT_PATH',
    'MPESA_CALLBACK_URL',
    'MPESA_CALLBACK_SECRET'
  ].forEach((k) => {
    if (!process.env[k]) missing.push(k);
  });
  if (missing.length > 0) {
    throw new Error(`M-Pesa B2C is not configured. Missing in .env: ${missing.join(', ')}`);
  }
}

async function getAccessToken() {
  const { key, secret } = consumerCredentials();
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  if (!res.ok) {
    throw new Error(
      `Could not get an M-Pesa access token for B2C (HTTP ${res.status}). Check the consumer key and secret of the app that has the B2C product.`
    );
  }
  const data = await res.json();
  tokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000
  });
  return data.access_token;
}

// Safaricom wants the initiator password encrypted with its public certificate (RSA, PKCS#1 v1.5), then base64.
function makeSecurityCredential() {
  const certPath = path.resolve(process.cwd(), String(process.env.MPESA_B2C_CERT_PATH).trim());
  let raw;
  try {
    raw = fs.readFileSync(certPath);
  } catch (err) {
    throw new Error(`Could not read the M-Pesa certificate at ${certPath}. Check MPESA_B2C_CERT_PATH.`);
  }

  let pem = raw.toString('utf8');
  if (!pem.includes('-----BEGIN')) {
    // The file is a binary (DER) certificate, so wrap it as PEM
    const b64 = raw.toString('base64').match(/.{1,64}/g).join('\n');
    pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  }

  const publicKey = crypto.createPublicKey(pem);
  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(process.env.MPESA_B2C_INITIATOR_PASSWORD))
  );
  return encrypted.toString('base64');
}

// The result and timeout URLs live next to your STK callback URL, so after a tunnel restart
// you still only change MPESA_CALLBACK_URL.
function b2cUrls() {
  const marker = '/api/mpesa/callback/';
  const callback = String(process.env.MPESA_CALLBACK_URL || '').trim();
  const at = callback.indexOf(marker);
  if (at === -1) {
    throw new Error('MPESA_CALLBACK_URL must look like https://<tunnel>/api/mpesa/callback/<secret>');
  }
  const base = callback.slice(0, at);
  const secret = String(process.env.MPESA_CALLBACK_SECRET).trim();
  return {
    result: `${base}/api/mpesa/b2c/result/${secret}`,
    timeout: `${base}/api/mpesa/b2c/timeout/${secret}`
  };
}

// Sends money to a phone. Returns Daraja's reply:
// { ConversationID, OriginatorConversationID, ResponseCode, ResponseDescription }
// A ResponseCode of '0' only means Safaricom ACCEPTED the request. The real outcome arrives at the result URL.
async function b2cPayment({ requestRef, phone, amount, remarks, occasion, commandId = 'BusinessPayment' }) {
  assertConfig();

  const wholeAmount = Number(amount);
  if (!Number.isInteger(wholeAmount) || wholeAmount < 1) {
    throw new Error('M-Pesa B2C amount must be a whole number of shillings (at least KES 1)');
  }
  const msisdn = normalizePhone(phone);
  if (!msisdn) throw new Error('The recipient does not have a valid Safaricom number');

  const token = await getAccessToken();
  const urls = b2cUrls();

  const body = {
    InitiatorName: process.env.MPESA_B2C_INITIATOR_NAME,
    SecurityCredential: makeSecurityCredential(),
    CommandID: commandId,
    Amount: wholeAmount,
    PartyA: process.env.MPESA_B2C_SHORTCODE,
    PartyB: msisdn,
    Remarks: String(remarks || 'Chama payment').slice(0, 100),
    QueueTimeOutURL: urls.timeout,
    ResultURL: urls.result,
    Occassion: String(occasion || '').slice(0, 100) // Daraja really does spell it with two c's
  };
  if (B2C_PATH.includes('/v3/')) body.OriginatorConversationID = requestRef;

  const res = await fetch(`${BASE_URL}${B2C_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || String(data.ResponseCode) !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || 'M-Pesa B2C request failed');
  }
  return data;
}

// Flattens the result Safaricom POSTs to your result (or timeout) URL.
function parseB2CResult(body) {
  const r = body && body.Result;
  if (!r || (!r.ConversationID && !r.OriginatorConversationID)) return null;

  let params = r.ResultParameters && r.ResultParameters.ResultParameter;
  if (params && !Array.isArray(params)) params = [params]; // a single parameter can arrive as an object
  const meta = {};
  (params || []).forEach((p) => {
    meta[p.Key] = p.Value;
  });

  return {
    conversationId: r.ConversationID || null,
    originatorConversationId: r.OriginatorConversationID || null,
    resultCode: Number(r.ResultCode),
    resultDesc: r.ResultDesc || '',
    receipt: meta.TransactionReceipt || r.TransactionID || null,
    amount: meta.TransactionAmount !== undefined ? Number(meta.TransactionAmount) : null,
    receiverName: meta.ReceiverPartyPublicName ? String(meta.ReceiverPartyPublicName) : null
  };
}

module.exports = { b2cPayment, parseB2CResult, makeSecurityCredential, b2cUrls };