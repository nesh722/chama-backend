const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const authMiddleware = require('../middleware/authMiddleware');
const requireTwoFactor = require('../middleware/requireTwoFactor');

router.post('/request', authMiddleware, loanController.requestLoan);
router.patch('/:loanId/decide', authMiddleware, requireTwoFactor, loanController.decideLoan);
router.post('/:loanId/repay', authMiddleware, loanController.recordRepayment);
router.get('/group/:groupId', authMiddleware, loanController.getGroupLoans);
router.get('/my-loans', authMiddleware, loanController.getMyLoans);
router.get('/pending-approvals', authMiddleware, loanController.getPendingApprovals);

module.exports = router;