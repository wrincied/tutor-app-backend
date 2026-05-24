const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectChanges, collectPatchChanges } = require('./activityLog');

describe('activityLog', () => {
  it('collectChanges detects field updates', () => {
    const before = { name: 'Anna', rate_per_hour: 20, timezone: 'Europe/Vienna' };
    const after = { name: 'Anna', rate_per_hour: 25, timezone: 'Europe/Moscow' };
    assert.deepEqual(collectChanges(before, after), [
      { field: 'rate_per_hour', from: 20, to: 25 },
      { field: 'timezone', from: 'Europe/Vienna', to: 'Europe/Moscow' },
    ]);
  });

  it('collectPatchChanges uses only patched keys', () => {
    const before = { name: 'Anna', bot_active: false, balance_lessons: 3 };
    const patch = { bot_active: true };
    assert.deepEqual(collectPatchChanges(before, patch), [
      { field: 'bot_active', from: false, to: true },
    ]);
  });
});
