const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/request', authMiddleware, loanController.requestLoan);
router.patch('/:loanId/decide', authMiddleware, loanController.decideLoan);
router.post('/:loanId/repay', authMiddleware, loanController.recordRepayment);
router.get('/group/:groupId', authMiddleware, loanController.getGroupLoans);
router.get('/my-loans', authMiddleware, loanController.getMyLoans);
router.get('/pending-approvals', authMiddleware, loanController.getPendingApprovals);

module.exports = router;