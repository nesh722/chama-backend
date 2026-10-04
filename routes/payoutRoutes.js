const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/setup', authMiddleware, payoutController.setupRotation);
router.get('/group/:groupId', authMiddleware, payoutController.getRotationStatus);
router.post('/mark-payout', authMiddleware, payoutController.markPayout);

module.exports = router;