/** Цены Basis / Pro и валюта по стране (синхронно с фронтом). */

const PRO_PRICING_BY_COUNTRY = {
  AT: { country: 'AT', currency: 'EUR', monthly: 9.99, yearly: 99.99 },
  DE: { country: 'DE', currency: 'EUR', monthly: 9.99, yearly: 99.99 },
  PL: { country: 'PL', currency: 'PLN', monthly: 39, yearly: 390 },
  US: { country: 'US', currency: 'USD', monthly: 11.99, yearly: 119.99 },
  KZ: { country: 'KZ', currency: 'KZT', monthly: 3900, yearly: 39000 },
  BY: { country: 'BY', currency: 'BYN', monthly: 19.99, yearly: 199.99 },
  RU: { country: 'RU', currency: 'RUB', monthly: 590, yearly: 5900 },
  UA: { country: 'UA', currency: 'UAH', monthly: 399, yearly: 3990 },
};

const BASIS_PRICING_BY_COUNTRY = {
  AT: { country: 'AT', currency: 'EUR', monthly: 5.99, yearly: 59.99 },
  DE: { country: 'DE', currency: 'EUR', monthly: 5.99, yearly: 59.99 },
  PL: { country: 'PL', currency: 'PLN', monthly: 23, yearly: 230 },
  US: { country: 'US', currency: 'USD', monthly: 6.99, yearly: 69.99 },
  KZ: { country: 'KZ', currency: 'KZT', monthly: 2300, yearly: 23000 },
  BY: { country: 'BY', currency: 'BYN', monthly: 11.99, yearly: 119.99 },
  RU: { country: 'RU', currency: 'RUB', monthly: 349, yearly: 3490 },
  UA: { country: 'UA', currency: 'UAH', monthly: 239, yearly: 2390 },
};

const { UN_MEMBER_COUNTRY_CODE_SET } = require('../data/unCountryCodes');

const PRICING_COUNTRIES = new Set(Object.keys(PRO_PRICING_BY_COUNTRY));
const DEFAULT_COUNTRY = 'AT';
/** @deprecated Use PRO_PRICING_BY_COUNTRY */
const PRICING_BY_COUNTRY = PRO_PRICING_BY_COUNTRY;

/** Код страны — члена ООН (для профиля и онбординга). */
function normalizeCountryCode(raw) {
  const code = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!code || code.length !== 2) {
    return null;
  }
  return UN_MEMBER_COUNTRY_CODE_SET.has(code) ? code : null;
}

function getSubscriptionPricing(country) {
  const code = normalizeCountryCode(country) ?? DEFAULT_COUNTRY;
  return PRO_PRICING_BY_COUNTRY[code] ?? PRO_PRICING_BY_COUNTRY[DEFAULT_COUNTRY];
}

function getPlanPricing(plan, country) {
  const code = normalizeCountryCode(country) ?? DEFAULT_COUNTRY;
  if (plan === 'basis') {
    return BASIS_PRICING_BY_COUNTRY[code] ?? BASIS_PRICING_BY_COUNTRY[DEFAULT_COUNTRY];
  }
  return PRO_PRICING_BY_COUNTRY[code] ?? PRO_PRICING_BY_COUNTRY[DEFAULT_COUNTRY];
}

const PRICING_TAX_MODES = new Set([
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

function normalizeTaxModeForPricing(raw) {
  const value = String(raw ?? 'none').trim();
  if (!value || value === 'none') {
    return 'none';
  }
  if (value === 'austria-self-employed') {
    return 'at-self-employed';
  }
  return value;
}

/** ISO country from tax_mode prefix (e.g. pl-ryczalt → PL). */
function countryFromTaxMode(raw) {
  const mode = normalizeTaxModeForPricing(raw);
  if (!PRICING_TAX_MODES.has(mode)) {
    return null;
  }
  const prefix = mode.split('-')[0]?.toUpperCase();
  return prefix && prefix.length === 2 ? prefix : null;
}

/** Country for subscription pricing: tax regime overrides stored country_settings. */
function resolvePricingCountry(taxMode, countrySettings) {
  const fromTax = countryFromTaxMode(taxMode);
  if (fromTax) {
    return fromTax;
  }
  return normalizeCountryCode(countrySettings) ?? DEFAULT_COUNTRY;
}

function getStripePriceIdForCountry(country, interval = 'monthly', plan = 'pro') {
  const code = normalizeCountryCode(country) ?? DEFAULT_COUNTRY;
  const pricingCode = PRO_PRICING_BY_COUNTRY[code] ? code : DEFAULT_COUNTRY;
  const suffix = interval === 'yearly' ? 'YEARLY' : 'MONTHLY';
  const planKey = plan === 'basis' ? 'BASIS' : 'PRO';
  const specific =
    process.env[`STRIPE_PRICE_ID_${planKey}_${pricingCode}_${suffix}`] ||
    process.env[`STRIPE_PRICE_ID_${planKey}_${pricingCode}`];
  if (specific) {
    return specific;
  }
  if (plan === 'basis') {
    if (interval === 'yearly' && process.env.STRIPE_PRICE_ID_BASIS_YEARLY) {
      return process.env.STRIPE_PRICE_ID_BASIS_YEARLY;
    }
    return process.env.STRIPE_PRICE_ID_BASIS || null;
  }
  if (interval === 'yearly' && process.env.STRIPE_PRICE_ID_PRO_YEARLY) {
    return process.env.STRIPE_PRICE_ID_PRO_YEARLY;
  }
  return process.env.STRIPE_PRICE_ID_PRO;
}

/** Stripe zero-decimal currencies (amount is already in major units). */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

function toStripeUnitAmount(amount, currency) {
  const code = String(currency || '').trim().toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(Number(amount) || 0);
  }
  return Math.round((Number(amount) || 0) * 100);
}

module.exports = {
  PRICING_COUNTRIES,
  DEFAULT_COUNTRY,
  normalizeCountryCode,
  countryFromTaxMode,
  resolvePricingCountry,
  getSubscriptionPricing,
  getPlanPricing,
  getStripePriceIdForCountry,
  toStripeUnitAmount,
  PRICING_BY_COUNTRY,
  PRO_PRICING_BY_COUNTRY,
  BASIS_PRICING_BY_COUNTRY,
};
