/** Курсы: сколько единиц валюты за 1 EUR (база Frankfurter + запасные BYN/KZT). */

const SUPPORTED = new Set(['EUR', 'USD', 'PLN', 'RUB', 'BYN', 'KZT']);

/** Запасные курсы (единиц валюты за 1 EUR), если API недоступен. */
const FALLBACK_EUR_RATES = {
  EUR: 1,
  USD: 1.09,
  PLN: 4.3,
  RUB: 98,
  BYN: 3.55,
  KZT: 520,
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const FRANKFURTER_URL =
  'https://api.frankfurter.app/latest?from=EUR&to=USD,PLN,RUB,BYN,KZT';

let cachedRates = null;
let cachedAt = 0;
let cachedDate = null;

function normalizeCurrency(code) {
  const c = String(code ?? 'EUR')
    .trim()
    .toUpperCase();
  return SUPPORTED.has(c) ? c : 'EUR';
}

function roundMoney(amount) {
  return Math.round(amount * 100) / 100;
}

/**
 * @param {number} amount
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {Record<string, number>} eurRates — единиц валюты за 1 EUR
 */
function convertAmount(amount, fromCurrency, toCurrency, eurRates) {
  const value = Number(amount);
  if (Number.isNaN(value) || value === 0) {
    return 0;
  }
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (from === to) {
    return roundMoney(value);
  }
  const fromRate = eurRates[from];
  const toRate = eurRates[to];
  if (!fromRate || !toRate || fromRate <= 0 || toRate <= 0) {
    return roundMoney(value);
  }
  const inEur = value / fromRate;
  return roundMoney(inEur * toRate);
}

async function fetchFrankfurterRates() {
  const res = await fetch(FRANKFURTER_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Frankfurter HTTP ${res.status}`);
  }
  const data = await res.json();
  const rates = { EUR: 1, ...FALLBACK_EUR_RATES, ...(data.rates ?? {}) };
  for (const code of SUPPORTED) {
    if (!rates[code] || rates[code] <= 0) {
      rates[code] = FALLBACK_EUR_RATES[code];
    }
  }
  return { rates, date: data.date ?? new Date().toISOString().slice(0, 10) };
}

/**
 * Курсы «единиц валюты за 1 EUR» с кэшем ~1 ч.
 * @returns {Promise<{ rates: Record<string, number>, date: string, source: string }>}
 */
async function getExchangeRates() {
  const now = Date.now();
  if (cachedRates && now - cachedAt < CACHE_TTL_MS) {
    return {
      rates: cachedRates,
      date: cachedDate,
      source: 'cache',
    };
  }

  try {
    const { rates, date } = await fetchFrankfurterRates();
    cachedRates = rates;
    cachedAt = now;
    cachedDate = date;
    return { rates, date, source: 'frankfurter' };
  } catch {
    cachedRates = { ...FALLBACK_EUR_RATES };
    cachedAt = now;
    cachedDate = new Date().toISOString().slice(0, 10);
    return {
      rates: cachedRates,
      date: cachedDate,
      source: 'fallback',
    };
  }
}

/** Курсы для ответа API (единиц валюты за 1 EUR). */
function ratesForReport(eurRates) {
  const out = {};
  for (const code of SUPPORTED) {
    if (eurRates[code]) {
      out[code] = eurRates[code];
    }
  }
  return out;
}

module.exports = {
  SUPPORTED,
  FALLBACK_EUR_RATES,
  normalizeCurrency,
  convertAmount,
  getExchangeRates,
  ratesForReport,
  roundMoney,
};
