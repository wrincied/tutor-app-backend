const express = require('express');
const router = express.Router();
const { runLessonBotNotifyTick } = require('../workers/lessonBotNotify');

function workerSecret() {
  return String(process.env.WORKER_TICK_SECRET || process.env.BOT_API_SECRET || '').trim();
}

function requireWorkerSecret(req, res, next) {
  const expected = workerSecret();
  if (!expected) {
    return res.status(503).json({
      message: 'Worker tick secret not configured (WORKER_TICK_SECRET or BOT_API_SECRET)',
      code: 'WORKER_TICK_UNCONFIGURED',
    });
  }
  const header = String(req.get('x-worker-secret') || '').trim();
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const got = header || bearer;
  if (!got || got !== expected) {
    return res.status(401).json({ message: 'Unauthorized', code: 'WORKER_TICK_UNAUTHORIZED' });
  }
  return next();
}

/**
 * Cloud Scheduler → wake backend (minInstances:0) and run one lessonBotNotify tick.
 * POST /api/internal/lesson-worker/tick
 * Header: X-Worker-Secret: <WORKER_TICK_SECRET|BOT_API_SECRET>
 */
router.post('/lesson-worker/tick', requireWorkerSecret, async (req, res) => {
  const started = Date.now();
  try {
    const result = await runLessonBotNotifyTick();
    res.json({
      ok: true,
      ms: Date.now() - started,
      ...result,
    });
  } catch (err) {
    console.error('[internal/lesson-worker/tick]', err?.message || err);
    res.status(500).json({
      ok: false,
      message: err?.message || 'tick failed',
    });
  }
});

module.exports = router;
