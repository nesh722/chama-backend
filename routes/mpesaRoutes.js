const express = require('express');
const router = express.Router();
const mpesaController = require('../controllers/mpesaController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/pay', authMiddleware, mpesaController.pay);
router.get('/status/:paymentId', authMiddleware, mpesaController.status);

// Called by Safaricom, so it can't carry a login token. The secret in the URL protects it.
router.post('/callback/:secret', mpesaController.callback);

module.exports = router;