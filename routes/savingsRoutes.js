const express = require('express');
const router = express.Router();
const savingsController = require('../controllers/savingsController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/log', authMiddleware, savingsController.logSavings);
router.get('/group/:groupId', authMiddleware, savingsController.getGroupSavings);
router.get('/my-savings', authMiddleware, savingsController.getMySavings);

module.exports = router;
