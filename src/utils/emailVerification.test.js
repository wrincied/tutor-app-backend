const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashVerificationToken,
  isEmailVerified,
  canResendVerification,
} = require('./emailVerification');

describe('emailVerification', () => {
  it('hashes tokens deterministically', () => {
    const a = hashVerificationToken('abc');
    const b = hashVerificationToken('abc');
    assert.equal(a, b);
    assert.notEqual(a, hashVerificationToken('xyz'));
  });

  it('treats missing email_verified as verified for legacy users', () => {
    assert.equal(isEmailVerified({}), true);
    assert.equal(isEmailVerified({ email_verified: true }), true);
    assert.equal(isEmailVerified({ email_verified: false }), false);
  });

  it('enforces resend cooldown', () => {
    const recent = { email_verification_sent_at: new Date() };
    assert.equal(canResendVerification(recent), false);
    const old = { email_verification_sent_at: new Date(Date.now() - 5 * 60 * 1000) };
    assert.equal(canResendVerification(old), true);
  });
});
