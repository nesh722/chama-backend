const express = require('express');
const router = express.Router();
const controller = require('../controllers/mpesaB2CController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/send', authMiddleware, controller.send);
router.get('/group/:groupId', authMiddleware, controller.listForGroup);
router.get('/status/:id', authMiddleware, controller.status);
router.post('/release/:id', authMiddleware, controller.release);

// Called by Safaricom, so they can't carry a login token. The secret in the URL protects them.
router.post('/result/:secret', controller.result);
router.post('/timeout/:secret', controller.timeout);

module.exports = router;