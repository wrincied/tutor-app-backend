const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isBlockedBrandEmail,
  isBrandEmailWhitelisted,
  isAdminAllowlistedEmail,
} = require('./brandEmail');

describe('brandEmail', () => {
  it('blocks non-whitelisted @simple4u.at', () => {
    assert.equal(isBlockedBrandEmail('support@simple4u.at'), true);
    assert.equal(isBlockedBrandEmail('hello@simple4u.at'), true);
    assert.equal(isBlockedBrandEmail('ADMIN@Simple4u.at'), false);
    assert.equal(isBrandEmailWhitelisted('admin@simple4u.at'), true);
  });

  it('allows external domains', () => {
    assert.equal(isBlockedBrandEmail('user@gmail.com'), false);
  });

  it('admin allowlist defaults to admin@', () => {
    assert.equal(isAdminAllowlistedEmail('admin@simple4u.at'), true);
    assert.equal(isAdminAllowlistedEmail('support@simple4u.at'), false);
  });
});
