/** @typedef {'free' | 'pro' | 'trial'} SubscriptionStatus */

const {
  getSubscriptionPricing,
  normalizeCountryCode,
  DEFAULT_COUNTRY,
} = require('./subscriptionPricing');

const ALLOWED_TAX_MODES = new Set([
  'at-self-employed',
  'de-kleinunternehmer',
  'pl-ryczalt',
  'ru-usn',
  'ru-ip',
  'by-ip',
  'kz-ip',
]);

const ALLOWED_SUBSCRIPTION = new Set(['free', 'pro', 'trial']);

/** Legacy Firestore values → canonical tax_mode. */
function normalizeTaxMode(raw) {
  const value = String(raw ?? 'none').trim();
  if (!value || value === 'none') {
    return 'none';
  }
  if (value === 'austria-self-employed') {
    return 'at-self-employed';
  }
  return value;
}

function isTaxModeConfigured(raw) {
  const mode = normalizeTaxMode(raw);
  return mode !== 'none' && ALLOWED_TAX_MODES.has(mode);
}

function assertConfigurableTaxMode(raw) {
  const mode = normalizeTaxMode(raw);
  if (!ALLOWED_TAX_MODES.has(mode)) {
    return { ok: false, message: 'Select a valid tax regime' };
  }
  return { ok: true, mode };
}

function subscriptionLabel(status) {
  const s = String(status ?? 'free');
  return ALLOWED_SUBSCRIPTION.has(s) ? s : 'free';
}

function normalizeRole(raw) {
  return String(raw ?? 'tutor').trim() === 'super_admin' ? 'super_admin' : 'tutor';
}

function canPurchaseSubscription(user) {
  return isTaxModeConfigured(user?.tax_mode) && subscriptionLabel(user?.subscription_status) === 'free';
}

function enrichUserProfile(user) {
  const tax_mode = normalizeTaxMode(user.tax_mode);
  const country_settings =
    normalizeCountryCode(user.country_settings) ?? DEFAULT_COUNTRY;
  const first_name = String(user.first_name ?? '').trim();
  const last_name = String(user.last_name ?? '').trim();
  const name =
    String(user.name ?? '').trim() || `${first_name} ${last_name}`.trim();

  return {
    ...user,
    first_name,
    last_name,
    name,
    onboarding_completed: user.onboarding_completed === true,
    data_consent_accepted:
      user.data_consent_accepted === true
        ? true
        : user.data_consent_accepted === false
          ? false
          : null,
    marketing_cookies_accepted:
      user.marketing_cookies_accepted === true
        ? true
        : user.marketing_cookies_accepted === false
          ? false
          : null,
    country_settings,
    tax_mode,
    tax_mode_configured: isTaxModeConfigured(tax_mode),
    subscription_status: subscriptionLabel(user.subscription_status),
    subscription_pricing: getSubscriptionPricing(country_settings),
    role: normalizeRole(user.role),
  };
}

module.exports = {
  ALLOWED_TAX_MODES,
  ALLOWED_SUBSCRIPTION,
  normalizeTaxMode,
  isTaxModeConfigured,
  assertConfigurableTaxMode,
  subscriptionLabel,
  normalizeRole,
  canPurchaseSubscription,
  enrichUserProfile,
};
