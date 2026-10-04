const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/:groupId/:type', authMiddleware, reportController.getReport);
router.get('/:groupId/:type/export', authMiddleware, reportController.exportReport);

module.exports = router;