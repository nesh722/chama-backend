// Mounted at /api/announcements in server.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/announcementController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/', authMiddleware, controller.create);
router.get('/group/:groupId', authMiddleware, controller.listForGroup);
router.delete('/:id', authMiddleware, controller.remove);

module.exports = router;