const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  addOneYearUnix,
  buildEarlyYearPhases,
  scheduleAlreadyHasYearTwo,
} = require('./stripeEarlySchedule');

describe('stripeEarlySchedule', () => {
  it('trialing yearly: first phase ends one year after trial, no iterations', () => {
    const trialEnd = 1_800_000_000;
    const phases = buildEarlyYearPhases(
      { status: 'trialing', trial_end: trialEnd, metadata: { earlyYearly: '1' } },
      {
        start_date: trialEnd - 7 * 86400,
        items: [{ price: 'price_early', quantity: 1 }],
      },
      'price_standard',
    );
    assert.equal(phases[0].iterations, undefined);
    assert.equal(phases[0].trial_end, trialEnd);
    assert.equal(phases[0].end_date, addOneYearUnix(trialEnd));
    assert.equal(phases[1].items[0].price, 'price_standard');
    assert.equal(phases[1].metadata.earlyYearly, '0');
  });

  it('active yearly: keeps current phase end_date', () => {
    const phases = buildEarlyYearPhases(
      { status: 'active', metadata: {} },
      {
        start_date: 1_700_000_000,
        end_date: 1_731_600_000,
        items: [{ price: { id: 'price_early' }, quantity: 1 }],
      },
      'price_standard',
    );
    assert.equal(phases[0].end_date, 1_731_600_000);
    assert.equal(phases[0].trial_end, undefined);
  });

  it('detects incomplete wrapper schedules', () => {
    assert.equal(scheduleAlreadyHasYearTwo({ phases: [{ items: [] }] }, 'price_std'), false);
    assert.equal(
      scheduleAlreadyHasYearTwo(
        { phases: [{ items: [] }, { items: [{ price: 'price_std' }] }] },
        'price_std',
      ),
      true,
    );
  });
});
