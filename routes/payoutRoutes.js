const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const payoutApprovalController = require('../controllers/payoutApprovalController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/setup', authMiddleware, payoutController.setupRotation);
router.get('/group/:groupId', authMiddleware, payoutController.getRotationStatus);
router.post('/mark-payout', authMiddleware, payoutController.markPayout);
router.get('/history/:groupId', authMiddleware, payoutController.getRotationHistory);

// Second approver for payouts
router.post('/request', authMiddleware, payoutApprovalController.requestApproval);
router.get('/approval/:groupId', authMiddleware, payoutApprovalController.getCurrent);
router.patch('/approvals/:approvalId/decide', authMiddleware, payoutApprovalController.decide);
router.post('/approvals/:approvalId/cancel', authMiddleware, payoutApprovalController.cancel);
module.exports = router;