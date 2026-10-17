const { rateLimit } = require('express-rate-limit');

// Requesting a reset email: 5 per 15 minutes per IP
exports.resetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many reset requests. Please wait 15 minutes and try again.'
  }
});

// Submitting a reset code: 10 attempts per 15 minutes per IP (stops code guessing)
exports.resetAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please wait 15 minutes and try again.'
  }
});

// Login: 10 failed attempts per 15 minutes per IP. Successful logins don't count.
exports.loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please wait 15 minutes and try again.'
  }
});

// Login: 10 failed attempts per 15 minutes per email address, regardless of IP.
// Stops someone spreading guesses for one account across many devices.
exports.loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.body?.email || '').toLowerCase().trim() || 'no-email',
  message: {
    success: false,
    message: 'Too many login attempts for this account. Please wait 15 minutes and try again.'
  }
});