const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { emailDomain, isDisposableEmail } = require('./disposableEmailDomain');

describe('disposableEmailDomain', () => {
  it('extracts normalized email domain', () => {
    assert.equal(emailDomain(' Test@Mailinator.com '), 'mailinator.com');
  });

  it('returns empty domain for invalid emails', () => {
    assert.equal(emailDomain('not-an-email'), '');
    assert.equal(emailDomain('@domain.com'), '');
    assert.equal(emailDomain('user@'), '');
  });

  it('detects disposable domains from blocklist', () => {
    assert.equal(isDisposableEmail('user@mailinator.com'), true);
    assert.equal(isDisposableEmail('user@gmail.com'), false);
  });
});
