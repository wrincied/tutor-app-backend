const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  EARLY_YEARLY_EUR,
  resolveCheckoutOffer,
  tributePeriodAmounts,
} = require('./checkoutOffer');

const atUser = { tax_mode: 'at-self-employed', country_settings: 'AT' };

describe('checkoutOffer', () => {
  it('catalog Pro yearly AT is 99.99 / 9.99 monthly', () => {
    const yearly = resolveCheckoutOffer(atUser, { plan: 'pro', interval: 'yearly' });
    assert.equal(yearly.catalogMajor, 99.99);
    assert.equal(yearly.firstChargeMajor, 99.99);
    assert.equal(yearly.referralPercent, 0);
    assert.equal(yearly.trialDays, 7);
    const monthly = resolveCheckoutOffer(atUser, { plan: 'pro', interval: 'monthly' });
    assert.equal(monthly.catalogMajor, 9.99);
  });

  it('early yearly XOR referral: 59.99 first year then 99.99', () => {
    const offer = resolveCheckoutOffer(
      { ...atUser, isEarlyAdopter: true, referredBy: 'someone' },
      { plan: 'pro', interval: 'yearly' },
    );
    assert.equal(offer.earlyYearly, true);
    assert.equal(offer.referralPercent, 0);
    assert.equal(offer.firstChargeMajor, EARLY_YEARLY_EUR);
    assert.equal(offer.recurringMajor, 99.99);
  });

  it('referral 20% on first charge when not early', () => {
    const offer = resolveCheckoutOffer(
      { ...atUser, referredBy: 'referrer-1' },
      { plan: 'pro', interval: 'yearly' },
    );
    assert.equal(offer.referralPercent, 20);
    assert.equal(offer.firstChargeMajor, 79.99);
    assert.equal(offer.recurringMajor, 99.99);
  });

  it('early does not apply to monthly Pro', () => {
    const offer = resolveCheckoutOffer(
      { ...atUser, isEarlyAdopter: true },
      { plan: 'pro', interval: 'monthly' },
    );
    assert.equal(offer.earlyYearly, false);
    assert.equal(offer.firstChargeMajor, 9.99);
  });

  it('tribute firstPeriodAmount only when first differs from recurring', () => {
    const referred = tributePeriodAmounts(
      resolveCheckoutOffer({ ...atUser, referredBy: 'r' }, { plan: 'pro', interval: 'monthly' }),
    );
    assert.equal(referred.amount, 999);
    assert.equal(referred.firstPeriodAmount, 799);
    const plain = tributePeriodAmounts(resolveCheckoutOffer(atUser, { plan: 'pro', interval: 'monthly' }));
    assert.equal(plain.firstPeriodAmount, undefined);
  });
});
