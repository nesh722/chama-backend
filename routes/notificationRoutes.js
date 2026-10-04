const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/my-notifications', authMiddleware, notificationController.getMyNotifications);
router.delete('/clear', authMiddleware, notificationController.clearAllNotifications);
router.patch('/:id/read', authMiddleware, notificationController.markAsRead);
router.post('/send', authMiddleware, notificationController.sendNotification);

module.exports = router;