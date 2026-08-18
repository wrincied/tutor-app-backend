const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldExpireManualPro, shouldExpireTrial } = require('./trialExpiry');

describe('trialExpiry manual Pro', () => {
  const now = Date.parse('2026-11-19T00:00:00.000Z');

  it('expires manual Pro past proExpiresAt', () => {
    assert.equal(
      shouldExpireManualPro(
        { subscription_status: 'pro', proExpiresAt: '2026-11-18T00:00:00.000Z' },
        now,
      ),
      true,
    );
  });

  it('does not expire Stripe Pro or unlimited manual Pro', () => {
    assert.equal(
      shouldExpireManualPro(
        {
          subscription_status: 'pro',
          proExpiresAt: '2026-11-18T00:00:00.000Z',
          stripe_subscription_id: 'sub_1',
        },
        now,
      ),
      false,
    );
    assert.equal(shouldExpireManualPro({ subscription_status: 'pro' }, now), false);
  });

  it('still expires admin trials', () => {
    assert.equal(
      shouldExpireTrial({ subscription_status: 'trial', trial_ends_at: '2026-01-01T00:00:00.000Z' }, now),
      true,
    );
  });
});
