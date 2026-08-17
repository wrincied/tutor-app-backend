const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toAppActionLink } = require('../utils/authActionLink');

describe('toAppActionLink', () => {
  it('rewrites Firebase handler to SPA /auth/action', () => {
    const src =
      'https://tutorassis.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=ABC&apiKey=KEY';
    const out = toAppActionLink(src, 'https://simple4u.at');
    assert.ok(out.startsWith('https://simple4u.at/auth/action?'));
    assert.ok(out.includes('mode=verifyEmail'));
    assert.ok(out.includes('oobCode=ABC'));
  });
});
