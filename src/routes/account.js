const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const { listAllActivityLogs } = require('../utils/activityLog');

router.use(auth);
router.use(requireVerifiedEmail);

/** Все события workspace (students + finance) — единая лента в Account → Администрирование. */
router.get('/activity-logs', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const items = await listAllActivityLogs({ tutorId, limit: req.query.limit });
    res.json(items);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
