const express = require('express');
const router = express.Router();
const groupController = require('../controllers/groupController');
const authMiddleware = require('../middleware/authMiddleware');

// Public -- lets someone preview a group from a shared link/QR before logging in
router.get('/preview/:token', groupController.previewByToken);

// All routes below require login
router.post('/create', authMiddleware, groupController.createGroup);
router.post('/join', authMiddleware, groupController.joinGroup);
router.post('/join-by-token', authMiddleware, groupController.joinByToken);
router.get('/my-groups', authMiddleware, groupController.getMyGroups);
router.get('/my-savings-progress', authMiddleware, groupController.getMySavingsProgress);
router.get('/:id', authMiddleware, groupController.getGroupDetails);
router.get('/:id/invite', authMiddleware, groupController.getInviteToken);
router.post('/:id/regenerate-invite', authMiddleware, groupController.regenerateInviteToken);
router.post('/:id/set-target', authMiddleware, groupController.setSavingsTarget);
router.delete('/:id/savings-target', authMiddleware, groupController.removeSavingsTarget);
router.get('/:id/savings-target-history', authMiddleware, groupController.getSavingsTargetHistory);
router.get('/:id/savings-progress', authMiddleware, groupController.getSavingsProgress);
router.patch('/:id/change-role', authMiddleware, groupController.changeRole);
router.post('/:id/remove-member', authMiddleware, groupController.removeMember);
router.delete('/:id', authMiddleware, groupController.deleteGroup);

module.exports = router;
