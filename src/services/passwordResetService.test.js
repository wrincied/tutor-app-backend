const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { toAppActionLink } = require('../utils/authActionLink');

describe('password-reset link rewrite', () => {
  const prev = process.env.FRONTEND_URL;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = prev;
    }
  });

  it('keeps oob query on SPA /auth/action', () => {
    process.env.FRONTEND_URL = 'http://localhost:4200';
    const src =
      'https://tutorassis.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=ABC123&apiKey=KEY&lang=en&continueUrl=http%3A%2F%2Flocalhost%3A4200%2Flogin';
    const out = toAppActionLink(src, 'http://localhost:4200');
    assert.ok(out.startsWith('http://localhost:4200/auth/action?'));
    assert.ok(out.includes('mode=resetPassword'));
    assert.ok(out.includes('oobCode=ABC123'));
  });
});
