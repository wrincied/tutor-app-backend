/** @typedef {'free' | 'pro' | 'trial'} SubscriptionStatus */

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

function canPurchaseSubscription(user) {
  return isTaxModeConfigured(user?.tax_mode) && subscriptionLabel(user?.subscription_status) === 'free';
}

function enrichUserProfile(user) {
  const tax_mode = normalizeTaxMode(user.tax_mode);
  return {
    ...user,
    tax_mode,
    tax_mode_configured: isTaxModeConfigured(tax_mode),
    subscription_status: subscriptionLabel(user.subscription_status),
  };
}

module.exports = {
  ALLOWED_TAX_MODES,
  ALLOWED_SUBSCRIPTION,
  normalizeTaxMode,
  isTaxModeConfigured,
  assertConfigurableTaxMode,
  subscriptionLabel,
  canPurchaseSubscription,
  enrichUserProfile,
};
