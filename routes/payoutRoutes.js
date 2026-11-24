const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const payoutApprovalController = require('../controllers/payoutApprovalController');
const authMiddleware = require('../middleware/authMiddleware');
const requireTwoFactor = require('../middleware/requireTwoFactor');

router.post('/setup', authMiddleware, payoutController.setupRotation);
router.get('/group/:groupId', authMiddleware, payoutController.getRotationStatus);
router.post('/mark-payout', authMiddleware, requireTwoFactor, payoutController.markPayout);
router.get('/history/:groupId', authMiddleware, payoutController.getRotationHistory);

// Second approver for payouts
router.post('/request', authMiddleware, requireTwoFactor, payoutApprovalController.requestApproval);
router.get('/approval/:groupId', authMiddleware, payoutApprovalController.getCurrent);
router.patch('/approvals/:approvalId/decide', authMiddleware, requireTwoFactor, payoutApprovalController.decide);
router.post('/approvals/:approvalId/cancel', authMiddleware, payoutApprovalController.cancel);
module.exports = router;