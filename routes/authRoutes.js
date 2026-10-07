const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/profile', authMiddleware, authController.getProfile);
router.post('/request-password-reset', authController.requestPasswordReset);
router.post('/reset-password', authController.resetPassword);
router.post('/upload-avatar', authMiddleware, authController.uploadMiddleware, authController.uploadAvatar);
router.put('/update-profile', authMiddleware, authController.updateProfile);
router.put('/change-email', authMiddleware, authController.changeEmail);
router.put('/change-password', authMiddleware, authController.changePassword);
router.delete('/delete-account', authMiddleware, authController.deleteAccount);
router.post('/push-token', authMiddleware, authController.savePushToken);
module.exports = router;