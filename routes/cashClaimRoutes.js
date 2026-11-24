const express = require('express');
const router = express.Router();
const controller = require('../controllers/cashClaimController');
const authMiddleware = require('../middleware/authMiddleware');
const requireTwoFactor = require('../middleware/requireTwoFactor');

router.post('/', authMiddleware, controller.create);
router.get('/pending', authMiddleware, controller.listPending);
router.get('/group/:groupId', authMiddleware, controller.listForGroup);
router.post('/:id/confirm', authMiddleware, requireTwoFactor, controller.confirm);
router.post('/:id/reject', authMiddleware, requireTwoFactor, controller.reject);
router.post('/:id/cancel', authMiddleware, controller.cancel);
router.post('/:id/dismiss', authMiddleware, controller.dismiss);

module.exports = router;