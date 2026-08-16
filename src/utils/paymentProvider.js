/** CIS members pay via Tribute. Ukraine is not CIS → Stripe. */
const CIS_PAYMENT_COUNTRIES = Object.freeze([
  'AM',
  'AZ',
  'BY',
  'KZ',
  'KG',
  'MD',
  'RU',
  'TJ',
  'TM',
  'UZ',
]);

const CIS_SET = new Set(CIS_PAYMENT_COUNTRIES);

function normalizePaymentCountry(country) {
  return String(country ?? 'AT')
    .trim()
    .toUpperCase();
}

function isCisPaymentCountry(country) {
  return CIS_SET.has(normalizePaymentCountry(country));
}

function paymentProviderForCountry(country) {
  return isCisPaymentCountry(country) ? 'tribute' : 'stripe';
}

/**
 * Effective rail: CIS → Tribute when configured, otherwise Stripe fallback.
 */
function resolvePaymentProvider(country, options = {}) {
  const preferred = paymentProviderForCountry(country);
  const tributeReady = options.tributeReady === true;
  const stripeReady = options.stripeReady !== false;
  if (preferred === 'tribute' && tributeReady) {
    return 'tribute';
  }
  if (stripeReady) {
    return 'stripe';
  }
  return preferred;
}

function tributeCurrencyForCountry(country) {
  return normalizePaymentCountry(country) === 'RU' ? 'rub' : 'eur';
}

module.exports = {
  CIS_PAYMENT_COUNTRIES,
  normalizePaymentCountry,
  isCisPaymentCountry,
  paymentProviderForCountry,
  resolvePaymentProvider,
  tributeCurrencyForCountry,
};
