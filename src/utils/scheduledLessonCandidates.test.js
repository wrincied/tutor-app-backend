const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  COMPLETE_BUFFER_MS,
  MAX_LESSON_DURATION_MS,
  REMIND_NEAR_MAX_MS,
  REMIND_LONG_MAX_MS,
  REMIND_WINDOW_MS,
} = require('./scheduledLessonCandidates');

describe('scheduledLessonCandidates windows', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');

  it('near candidate window spans past auto-complete through +25h reminders', () => {
    const lower = now - COMPLETE_BUFFER_MS - MAX_LESSON_DURATION_MS;
    const upper = now + REMIND_NEAR_MAX_MS + REMIND_WINDOW_MS;
    assert.ok(lower < now - COMPLETE_BUFFER_MS);
    assert.ok(upper > now + 24 * 60 * 60 * 1000);
    // 60m offset reminder sits inside near window
    const startFor60m = now + 60 * 60 * 1000;
    assert.ok(startFor60m >= lower && startFor60m <= upper);
  });

  it('long-offset window covers custom offsets beyond +25h up to 7d', () => {
    const lower = now + REMIND_NEAR_MAX_MS - REMIND_WINDOW_MS;
    const upper = now + REMIND_LONG_MAX_MS + REMIND_WINDOW_MS;
    // 1440m (24h) is inside the near window; long pass is for custom >25h
    const startFor48h = now + 48 * 60 * 60 * 1000;
    assert.ok(startFor48h >= lower && startFor48h <= upper);
  });
});
