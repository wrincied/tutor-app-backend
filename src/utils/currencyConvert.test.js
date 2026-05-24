const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  convertAmount,
  normalizeCurrency,
  roundMoney,
  ratesForReport,
  FALLBACK_EUR_RATES,
} = require('./currencyConvert');

describe('normalizeCurrency', () => {
  it('returns supported currency uppercased', () => {
    assert.equal(normalizeCurrency('rub'), 'RUB');
  });

  it('falls back to EUR for unknown codes', () => {
    assert.equal(normalizeCurrency('GBP'), 'EUR');
    assert.equal(normalizeCurrency(''), 'EUR');
  });
});

describe('roundMoney', () => {
  it('rounds to two decimal places', () => {
    assert.equal(roundMoney(10.556), 10.56);
    assert.equal(roundMoney(10.554), 10.55);
  });
});

describe('convertAmount', () => {
  const rates = FALLBACK_EUR_RATES;

  it('returns 0 for NaN or zero', () => {
    assert.equal(convertAmount(0, 'EUR', 'USD', rates), 0);
    assert.equal(convertAmount(Number.NaN, 'EUR', 'USD', rates), 0);
  });

  it('returns same amount for identical currency', () => {
    assert.equal(convertAmount(100, 'EUR', 'EUR', rates), 100);
    assert.equal(convertAmount(100.555, 'eur', 'EUR', rates), 100.56);
  });

  it('converts RUB to EUR using eur-based rates', () => {
    const eur = convertAmount(9800, 'RUB', 'EUR', rates);
    assert.equal(eur, 100);
  });

  it('converts EUR to RUB', () => {
    const rub = convertAmount(100, 'EUR', 'RUB', rates);
    assert.equal(rub, 9800);
  });

  it('converts through EUR between non-EUR currencies', () => {
    const usd = convertAmount(9800, 'RUB', 'USD', rates);
    assert.equal(usd, 109);
  });

  it('returns rounded original amount when rate is missing', () => {
    assert.equal(convertAmount(50, 'RUB', 'EUR', { EUR: 1 }), 50);
  });
});

describe('ratesForReport', () => {
  it('includes only supported currencies present in rates', () => {
    const report = ratesForReport({ EUR: 1, RUB: 98, GBP: 0.85 });
    assert.deepEqual(report, { EUR: 1, RUB: 98 });
  });
});
