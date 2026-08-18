/**
 * Tribute shop/webhook is not production-complete yet.
 * CIS rails fall back to Stripe until TRIBUTE_API_KEY is set and the shop is live.
 * Ukraine is not CIS → Stripe.
 */
const CIS_PAYMENT_COUNTRIES = Object.freeze([
  'AM',
  'AZ',
  'BY',
  'KG',
  'MD',
  'RU',
  'TJ',
  'TM',
  'UZ',
]);

/** Both Stripe and Tribute offered when ready (user chooses). */
const MIXED_PAYMENT_COUNTRIES = Object.freeze(['KZ']);

const CIS_SET = new Set(CIS_PAYMENT_COUNTRIES);
const MIXED_SET = new Set(MIXED_PAYMENT_COUNTRIES);

function normalizePaymentCountry(country) {
  return String(country ?? 'AT')
    .trim()
    .toUpperCase();
}

function isCisPaymentCountry(country) {
  return CIS_SET.has(normalizePaymentCountry(country));
}

function isMixedPaymentCountry(country) {
  return MIXED_SET.has(normalizePaymentCountry(country));
}

function paymentRailForCountry(country) {
  const code = normalizePaymentCountry(country);
  if (MIXED_SET.has(code)) {
    return 'mixed';
  }
  if (CIS_SET.has(code)) {
    return 'tribute';
  }
  return 'stripe';
}

function paymentProviderForCountry(country) {
  const rail = paymentRailForCountry(country);
  if (rail === 'tribute') {
    return 'tribute';
  }
  return 'stripe';
}

function allowedPaymentProviders(country, options = {}) {
  const stripeReady = options.stripeReady !== false;
  const tributeReady = options.tributeReady === true;
  const rail = paymentRailForCountry(country);

  if (rail === 'mixed') {
    const out = [];
    if (stripeReady) {
      out.push('stripe');
    }
    if (tributeReady) {
      out.push('tribute');
    }
    if (out.length) {
      return out;
    }
    return stripeReady ? ['stripe'] : ['tribute'];
  }

  if (rail === 'tribute') {
    if (tributeReady) {
      return ['tribute'];
    }
    if (stripeReady) {
      return ['stripe'];
    }
    return ['tribute'];
  }

  return stripeReady ? ['stripe'] : [];
}

function isPaymentProviderAllowed(country, provider, options = {}) {
  return allowedPaymentProviders(country, options).includes(provider);
}

function resolvePaymentProvider(country, options = {}) {
  const allowed = allowedPaymentProviders(country, options);
  const preferred = paymentProviderForCountry(country);
  if (allowed.includes(preferred)) {
    return preferred;
  }
  return allowed[0] || preferred;
}

function tributeCurrencyForCountry(country) {
  return normalizePaymentCountry(country) === 'RU' ? 'rub' : 'eur';
}

module.exports = {
  CIS_PAYMENT_COUNTRIES,
  MIXED_PAYMENT_COUNTRIES,
  normalizePaymentCountry,
  isCisPaymentCountry,
  isMixedPaymentCountry,
  paymentRailForCountry,
  paymentProviderForCountry,
  allowedPaymentProviders,
  isPaymentProviderAllowed,
  resolvePaymentProvider,
  tributeCurrencyForCountry,
};
