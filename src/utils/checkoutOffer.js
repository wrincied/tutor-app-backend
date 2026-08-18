const {
  getPlanPricing,
  resolvePricingCountry,
  toStripeUnitAmount,
} = require('./subscriptionPricing');

const EARLY_YEARLY_EUR = 59.99;
const STANDARD_YEARLY_EUR = 99.99;
const REFERRAL_PERCENT = 20;
const TRIAL_DAYS = 7;

function roundMoney(amount) {
  return Math.round((Number(amount) || 0) * 100) / 100;
}

function earlyYearlyAmount(pricing) {
  const currency = String(pricing?.currency || 'EUR').toUpperCase();
  if (currency === 'EUR') {
    return EARLY_YEARLY_EUR;
  }
  const yearly = Number(pricing?.yearly) || 0;
  return roundMoney(yearly * (EARLY_YEARLY_EUR / STANDARD_YEARLY_EUR));
}

function hasReferralAttribution(user) {
  return Boolean(String(user?.referredBy || '').trim());
}

/**
 * Single offer for Stripe checkout and future Tribute Shop.
 * Early yearly XOR 20% referral. Trial always 7 days on Pro.
 */
function resolveCheckoutOffer(user, { plan, interval } = {}) {
  const planId = plan === 'basis' ? 'basis' : 'pro';
  const billingInterval = interval === 'yearly' ? 'yearly' : 'monthly';
  const country = resolvePricingCountry(user?.tax_mode, user?.country_settings);
  const pricing = getPlanPricing(planId, country);
  const catalogMajor = billingInterval === 'yearly' ? pricing.yearly : pricing.monthly;
  const earlyYearly =
    planId === 'pro' && billingInterval === 'yearly' && user?.isEarlyAdopter === true;
  const referralPercent =
    !earlyYearly && planId === 'pro' && hasReferralAttribution(user) ? REFERRAL_PERCENT : 0;

  let firstChargeMajor = catalogMajor;
  let recurringMajor = catalogMajor;
  if (earlyYearly) {
    firstChargeMajor = earlyYearlyAmount(pricing);
    recurringMajor = catalogMajor;
  } else if (referralPercent) {
    firstChargeMajor = roundMoney(catalogMajor * (1 - referralPercent / 100));
    recurringMajor = catalogMajor;
  }

  return {
    plan: planId,
    interval: billingInterval,
    country,
    currency: pricing.currency,
    catalogMajor,
    firstChargeMajor,
    recurringMajor,
    earlyYearly,
    referralPercent,
    trialDays: planId === 'pro' ? TRIAL_DAYS : 0,
    pricing,
  };
}

function tributePeriodAmounts(offer) {
  const currency = String(offer.currency || 'EUR').toLowerCase();
  const amount = toStripeUnitAmount(offer.recurringMajor, currency);
  const firstDiffers = Math.abs(offer.firstChargeMajor - offer.recurringMajor) > 0.001;
  return {
    currency,
    amount,
    firstPeriodAmount: firstDiffers ? toStripeUnitAmount(offer.firstChargeMajor, currency) : undefined,
  };
}

module.exports = {
  EARLY_YEARLY_EUR,
  STANDARD_YEARLY_EUR,
  REFERRAL_PERCENT,
  TRIAL_DAYS,
  roundMoney,
  earlyYearlyAmount,
  hasReferralAttribution,
  resolveCheckoutOffer,
  tributePeriodAmounts,
};
