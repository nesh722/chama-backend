const express = require('express');
const router = express.Router();
const contributionController = require('../controllers/contributionController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/log', authMiddleware, contributionController.logContribution);
router.get('/group/:groupId', authMiddleware, contributionController.getGroupContributions);
router.get('/my-contributions', authMiddleware, contributionController.getMyContributions);
router.get('/group/:groupId/defaulters', authMiddleware, contributionController.getDefaulters);
router.get('/my-due-status', authMiddleware, contributionController.getMyDueStatus);

module.exports = router;