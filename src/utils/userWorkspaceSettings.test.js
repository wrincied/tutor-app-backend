const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkspace } = require('./userWorkspaceSettings');

describe('normalizeWorkspace defaultLessonDuration', () => {
  it('keeps custom minutes in 5–480 range', () => {
    assert.equal(normalizeWorkspace({ defaultLessonDuration: 50 }).defaultLessonDuration, 50);
    assert.equal(normalizeWorkspace({ defaultLessonDuration: 55 }).defaultLessonDuration, 55);
  });

  it('clamps out-of-range values', () => {
    assert.equal(normalizeWorkspace({ defaultLessonDuration: 3 }).defaultLessonDuration, 5);
    assert.equal(normalizeWorkspace({ defaultLessonDuration: 999 }).defaultLessonDuration, 480);
  });

  it('keeps standard presets', () => {
    assert.equal(normalizeWorkspace({ defaultLessonDuration: 60 }).defaultLessonDuration, 60);
    assert.equal(normalizeWorkspace({ defaultLessonDuration: 90 }).defaultLessonDuration, 90);
  });

  it('persists roundLessonPrices and customReminderOffsets', () => {
    const next = normalizeWorkspace({
      roundLessonPrices: true,
      customReminderOffsets: [45, 15, 45, 99999],
    });
    assert.equal(next.roundLessonPrices, true);
    assert.deepEqual(next.customReminderOffsets, [45]);
  });
});
