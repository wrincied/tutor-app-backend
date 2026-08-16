/** @typedef {'free' | 'basis' | 'pro' | 'trial'} SubscriptionStatus */

const {
  getSubscriptionPricing,
  normalizeCountryCode,
  resolvePricingCountry,
  DEFAULT_COUNTRY,
} = require('./subscriptionPricing');
const { normalizeWorkspace, normalizeWorkingHours, normalizeVacation } = require('./userWorkspaceSettings');

const ALLOWED_TAX_MODES = new Set([
  'at-self-employed',
  'de-kleinunternehmer',
  'pl-ryczalt',
  'ru-usn',
  'ru-ip',
  'by-ip',
  'by-self-employed',
  'kz-ip',
  'ua-fop3',
]);

const ALLOWED_SUBSCRIPTION = new Set(['free', 'basis', 'pro', 'trial']);

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
  const status = subscriptionLabel(user?.subscription_status);
  return isTaxModeConfigured(user?.tax_mode) && (status === 'free' || status === 'basis');
}

function canPurchasePlan(user, plan) {
  if (!isTaxModeConfigured(user?.tax_mode)) {
    return false;
  }
  const status = subscriptionLabel(user?.subscription_status);
  if (plan === 'basis') {
    return status === 'free';
  }
  if (plan === 'pro' || plan === 'trial') {
    return status === 'free' || status === 'basis';
  }
  return false;
}

/** null = unlimited */
const PLAN_STUDENT_LIMITS = Object.freeze({
  free: 3,
  basis: 8,
  pro: null,
  trial: null,
});

function maxStudentsForPlan(status) {
  const s = subscriptionLabel(status);
  return Object.prototype.hasOwnProperty.call(PLAN_STUDENT_LIMITS, s)
    ? PLAN_STUDENT_LIMITS[s]
    : PLAN_STUDENT_LIMITS.free;
}

function hasFinanceAccess(status) {
  const s = subscriptionLabel(status);
  return s === 'basis' || s === 'pro' || s === 'trial';
}

function hasTelegramAccess(status) {
  const s = subscriptionLabel(status);
  return s === 'pro' || s === 'trial';
}

function getPlanEntitlements(status) {
  return {
    max_students: maxStudentsForPlan(status),
    has_finance: hasFinanceAccess(status),
    has_telegram: hasTelegramAccess(status),
  };
}

function enrichUserProfile(user) {
  const tax_mode = normalizeTaxMode(user.tax_mode);
  const country_settings =
    normalizeCountryCode(user.country_settings) ?? DEFAULT_COUNTRY;
  const pricingCountry = resolvePricingCountry(tax_mode, country_settings);
  const first_name = String(user.first_name ?? '').trim();
  const last_name = String(user.last_name ?? '').trim();
  const name =
    String(user.name ?? '').trim() || `${first_name} ${last_name}`.trim();
  const subscription_status = subscriptionLabel(user.subscription_status);

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
    subscription_status,
    plan_entitlements: getPlanEntitlements(subscription_status),
    subscription_pricing: getSubscriptionPricing(pricingCountry),
    trial_ends_at: user.trial_ends_at ?? null,
    cancel_at_period_end: user.cancel_at_period_end === true,
    subscription_cancel_at: user.subscription_cancel_at ?? null,
    subscription_current_period_end: user.subscription_current_period_end ?? null,
    subscription_interval:
      user.subscription_interval === 'yearly' || user.subscription_interval === 'monthly'
        ? user.subscription_interval
        : null,
    pending_plan: String(user.pending_plan || '').toLowerCase() === 'basis' ? 'basis' : null,
    pending_plan_at: user.pending_plan_at ?? null,
    has_stripe_subscription: Boolean(user.stripe_subscription_id),
    role: normalizeRole(user.role),
    workspace: normalizeWorkspace(user.workspace),
    workingHours: normalizeWorkingHours(user.workingHours),
    vacation: normalizeVacation(user.vacation),
  };
}

module.exports = {
  ALLOWED_TAX_MODES,
  ALLOWED_SUBSCRIPTION,
  PLAN_STUDENT_LIMITS,
  normalizeTaxMode,
  isTaxModeConfigured,
  assertConfigurableTaxMode,
  subscriptionLabel,
  normalizeRole,
  canPurchaseSubscription,
  canPurchasePlan,
  maxStudentsForPlan,
  hasFinanceAccess,
  hasTelegramAccess,
  getPlanEntitlements,
  enrichUserProfile,
};
