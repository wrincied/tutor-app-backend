const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isBlockedBrandEmail,
  isBrandEmailWhitelisted,
  isAdminAllowlistedEmail,
} = require('./brandEmail');

describe('brandEmail', () => {
  it('blocks non-whitelisted @simple4u.at', () => {
    assert.equal(isBlockedBrandEmail('admin@simple4u.at'), true);
    assert.equal(isBlockedBrandEmail('hello@simple4u.at'), true);
    assert.equal(isBlockedBrandEmail('SUPPORT@Simple4u.at'), false);
    assert.equal(isBrandEmailWhitelisted('support@simple4u.at'), true);
  });

  it('allows external domains', () => {
    assert.equal(isBlockedBrandEmail('user@gmail.com'), false);
  });

  it('admin allowlist defaults to support@', () => {
    assert.equal(isAdminAllowlistedEmail('support@simple4u.at'), true);
    assert.equal(isAdminAllowlistedEmail('admin@simple4u.at'), false);
  });

  it('keeps support@ whitelisted when ADMIN_EMAILS overrides', () => {
    const prev = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'someone@gmail.com';
    try {
      // Re-require to pick up env — brandEmail reads env at call time, so OK
      assert.equal(isBrandEmailWhitelisted('support@simple4u.at'), true);
      assert.equal(isBlockedBrandEmail('support@simple4u.at'), false);
      assert.equal(isAdminAllowlistedEmail('support@simple4u.at'), true);
      assert.equal(isAdminAllowlistedEmail('someone@gmail.com'), true);
    } finally {
      if (prev === undefined) {
        delete process.env.ADMIN_EMAILS;
      } else {
        process.env.ADMIN_EMAILS = prev;
      }
    }
  });
});
