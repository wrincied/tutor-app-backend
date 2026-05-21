const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTaxMode,
  isTaxModeConfigured,
  assertConfigurableTaxMode,
  canPurchaseSubscription,
  enrichUserProfile,
} = require('./userProfile');

describe('normalizeTaxMode', () => {
  it('maps empty and none to none', () => {
    assert.equal(normalizeTaxMode(''), 'none');
    assert.equal(normalizeTaxMode('none'), 'none');
    assert.equal(normalizeTaxMode(undefined), 'none');
  });

  it('maps legacy austria value', () => {
    assert.equal(normalizeTaxMode('austria-self-employed'), 'at-self-employed');
  });
});

describe('isTaxModeConfigured', () => {
  it('is false until a real regime is set', () => {
    assert.equal(isTaxModeConfigured('none'), false);
    assert.equal(isTaxModeConfigured('at-self-employed'), true);
  });
});

describe('assertConfigurableTaxMode', () => {
  it('rejects none', () => {
    assert.equal(assertConfigurableTaxMode('none').ok, false);
  });

  it('accepts valid mode', () => {
    const result = assertConfigurableTaxMode('ru-usn');
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'ru-usn');
  });
});

describe('canPurchaseSubscription', () => {
  it('requires tax mode and free plan', () => {
    assert.equal(canPurchaseSubscription({ tax_mode: 'none', subscription_status: 'free' }), false);
    assert.equal(
      canPurchaseSubscription({ tax_mode: 'at-self-employed', subscription_status: 'free' }),
      true,
    );
    assert.equal(
      canPurchaseSubscription({ tax_mode: 'at-self-employed', subscription_status: 'pro' }),
      false,
    );
  });
});

describe('enrichUserProfile', () => {
  it('adds tax_mode_configured flag', () => {
    const enriched = enrichUserProfile({ tax_mode: 'none', subscription_status: 'free' });
    assert.equal(enriched.tax_mode_configured, false);
    assert.equal(enriched.tax_mode, 'none');
  });
});
