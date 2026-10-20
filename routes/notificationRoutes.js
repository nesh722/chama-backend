const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const authMiddleware = require('../middleware/authMiddleware');
const { sendNotificationLimiter } = require('../middleware/rateLimiters');

router.get('/my-notifications', authMiddleware, notificationController.getMyNotifications);
router.delete('/clear', authMiddleware, notificationController.clearAllNotifications);
router.patch('/:id/read', authMiddleware, notificationController.markAsRead);
router.post('/send', authMiddleware, sendNotificationLimiter, notificationController.sendNotification);

module.exports = router;