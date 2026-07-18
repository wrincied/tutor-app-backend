/** Курсы: сколько единиц валюты за 1 EUR (официальные ЦБ + кэш ~1 ч). */

const { fetchCentralBankRates } = require('./exchangeRateFetchers');

const SUPPORTED = new Set(['EUR', 'USD', 'PLN', 'RUB', 'BYN', 'KZT', 'UAH']);

/** Запасные курсы (единиц валюты за 1 EUR), если ЦБ недоступен. */
const FALLBACK_EUR_RATES = {
  EUR: 1,
  USD: 1.09,
  PLN: 4.3,
  RUB: 98,
  BYN: 3.55,
  KZT: 520,
  UAH: 45,
};

const CACHE_TTL_MS = 60 * 60 * 1000;

let cachedRates = null;
let cachedAt = 0;
let cachedDate = null;
let cachedSource = null;

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
      source: cachedSource,
    };
  }

  try {
    const { rates, date, source } = await fetchCentralBankRates(FALLBACK_EUR_RATES);
    cachedRates = rates;
    cachedAt = now;
    cachedDate = date;
    cachedSource = source;
    return { rates, date, source };
  } catch {
    cachedRates = { ...FALLBACK_EUR_RATES };
    cachedAt = now;
    cachedDate = todayIso();
    cachedSource = 'fallback';
    return {
      rates: cachedRates,
      date: cachedDate,
      source: cachedSource,
    };
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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
