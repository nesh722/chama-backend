// Mounted at /api/meetings in server.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/meetingController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/', authMiddleware, controller.create);
router.get('/upcoming', authMiddleware, controller.upcomingForMe); // must stay above '/:id'
router.get('/group/:groupId', authMiddleware, controller.listForGroup);
router.get('/:id', authMiddleware, controller.getOne);
router.patch('/:id', authMiddleware, controller.update);
router.put('/:id/attendance', authMiddleware, controller.saveAttendance);
router.put('/:id/minutes', authMiddleware, controller.saveMinutes);
router.post('/:id/apology', authMiddleware, controller.apology);

module.exports = router;