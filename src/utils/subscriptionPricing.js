/** Цены Pro и валюта по стране (синхронно с фронтом). */

const PRICING_BY_COUNTRY = {
  AT: { country: 'AT', currency: 'EUR', monthly: 9.99, yearly: 99.99 },
  DE: { country: 'DE', currency: 'EUR', monthly: 9.99, yearly: 99.99 },
  PL: { country: 'PL', currency: 'PLN', monthly: 39, yearly: 390 },
  US: { country: 'US', currency: 'USD', monthly: 11.99, yearly: 119.99 },
  KZ: { country: 'KZ', currency: 'KZT', monthly: 3900, yearly: 39000 },
  BY: { country: 'BY', currency: 'BYN', monthly: 19.99, yearly: 199.99 },
  RU: { country: 'RU', currency: 'RUB', monthly: 590, yearly: 5900 },
  UA: { country: 'UA', currency: 'UAH', monthly: 399, yearly: 3990 },
};

const { UN_MEMBER_COUNTRY_CODE_SET } = require('../data/unCountryCodes');

const PRICING_COUNTRIES = new Set(Object.keys(PRICING_BY_COUNTRY));
const DEFAULT_COUNTRY = 'AT';

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
  return PRICING_BY_COUNTRY[code] ?? PRICING_BY_COUNTRY[DEFAULT_COUNTRY];
}

function getStripePriceIdForCountry(country, interval = 'monthly') {
  const code = normalizeCountryCode(country) ?? DEFAULT_COUNTRY;
  const pricingCode = PRICING_BY_COUNTRY[code] ? code : DEFAULT_COUNTRY;
  const suffix = interval === 'yearly' ? 'YEARLY' : 'MONTHLY';
  const specific =
    process.env[`STRIPE_PRICE_ID_PRO_${pricingCode}_${suffix}`] ||
    process.env[`STRIPE_PRICE_ID_PRO_${pricingCode}`];
  if (specific) {
    return specific;
  }
  if (interval === 'yearly' && process.env.STRIPE_PRICE_ID_PRO_YEARLY) {
    return process.env.STRIPE_PRICE_ID_PRO_YEARLY;
  }
  return process.env.STRIPE_PRICE_ID_PRO;
}

module.exports = {
  PRICING_COUNTRIES,
  DEFAULT_COUNTRY,
  normalizeCountryCode,
  getSubscriptionPricing,
  getStripePriceIdForCountry,
  PRICING_BY_COUNTRY,
};
