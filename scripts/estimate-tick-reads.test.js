const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const modPath = path.join(__dirname, 'estimate-tick-reads.js');

describe('estimate-tick-reads', () => {
  it('after tick reads are far below before for default scenario', () => {
    delete require.cache[require.resolve(modPath)];
    const { estimate } = require(modPath);
    const { perTick } = estimate();
    assert.ok(perTick.after.total < perTick.before.total);
    assert.ok(perTick.dropPct >= 90, `expected >=90% drop, got ${perTick.dropPct}%`);
  });

  it('formula: before lessons = 3*scheduled + total + unbilled', () => {
    process.env.SCHEDULED_LESSONS = '100';
    process.env.TOTAL_LESSONS = '400';
    process.env.COMPLETED_UNBILLED = '2';
    process.env.RECURRING_LESSONS = '10';
    process.env.CANDIDATE_WINDOW_LESSONS = '5';
    process.env.RECURRING_WITH_COMPLETED_DATES = '0';
    process.env.AVG_COMPLETED_DATES_PER_SERIES = '0';
    delete require.cache[require.resolve(modPath)];
    const { estimate } = require(modPath);
    const { perTick } = estimate();
    assert.equal(perTick.before.lessons, 702);
    assert.equal(perTick.after.lessons, 17);
    for (const k of [
      'SCHEDULED_LESSONS',
      'TOTAL_LESSONS',
      'COMPLETED_UNBILLED',
      'RECURRING_LESSONS',
      'CANDIDATE_WINDOW_LESSONS',
      'RECURRING_WITH_COMPLETED_DATES',
      'AVG_COMPLETED_DATES_PER_SERIES',
    ]) {
      delete process.env[k];
    }
    delete require.cache[require.resolve(modPath)];
  });
});
