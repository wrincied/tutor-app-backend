const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isCisPaymentCountry,
  paymentProviderForCountry,
  resolvePaymentProvider,
  tributeCurrencyForCountry,
} = require('./paymentProvider');

describe('paymentProvider', () => {
  it('routes CIS to Tribute', () => {
    assert.equal(paymentProviderForCountry('RU'), 'tribute');
    assert.equal(paymentProviderForCountry('by'), 'tribute');
    assert.equal(paymentProviderForCountry('KZ'), 'tribute');
    assert.equal(isCisPaymentCountry('UZ'), true);
  });

  it('routes non-CIS including UA to Stripe', () => {
    assert.equal(paymentProviderForCountry('AT'), 'stripe');
    assert.equal(paymentProviderForCountry('UA'), 'stripe');
    assert.equal(paymentProviderForCountry('DE'), 'stripe');
  });

  it('falls back to Stripe when Tribute is not ready', () => {
    assert.equal(resolvePaymentProvider('RU', { tributeReady: false }), 'stripe');
    assert.equal(resolvePaymentProvider('BY', { tributeReady: true }), 'tribute');
    assert.equal(resolvePaymentProvider('AT', { tributeReady: false }), 'stripe');
  });

  it('Tribute currency is rub only for RU', () => {
    assert.equal(tributeCurrencyForCountry('RU'), 'rub');
    assert.equal(tributeCurrencyForCountry('BY'), 'eur');
  });
});
