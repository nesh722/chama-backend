const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
const { resetRequestLimiter, resetAttemptLimiter, loginLimiter,
  loginAccountLimiter } = require('../middleware/rateLimiters');

router.post('/register', authController.register);
router.post('/login', loginLimiter, loginAccountLimiter, authController.login);
router.get('/profile', authMiddleware, authController.getProfile);
router.post('/request-password-reset', resetRequestLimiter, authController.requestPasswordReset);
router.post('/reset-password', resetAttemptLimiter, authController.resetPassword);
router.post('/upload-avatar', authMiddleware, authController.uploadMiddleware, authController.uploadAvatar);
router.put('/update-profile', authMiddleware, authController.updateProfile);
router.put('/change-email', authMiddleware, authController.changeEmail);
router.put('/change-password', authMiddleware, authController.changePassword);
router.delete('/delete-account', authMiddleware, authController.deleteAccount);
router.post('/push-token', authMiddleware, authController.savePushToken);
module.exports = router;