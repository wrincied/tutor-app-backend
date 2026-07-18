const {
  sanitizeLegalMarkdown,
  sanitizeLegalTitle,
  isLegalDocId,
} = require('./legalContent');
const { isSafeFirestoreId } = require('./safeId');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('legalContent sanitize', () => {
  it('strips html tags', () => {
    const out = sanitizeLegalMarkdown('<script>alert(1)</script>Hello');
    assert.equal(out.includes('<script>'), false);
    assert.match(out, /Hello/);
  });

  it('removes javascript: urls', () => {
    const out = sanitizeLegalMarkdown('[x](javascript:alert(1))');
    assert.equal(out.toLowerCase().includes('javascript:'), false);
  });

  it('sanitizes title newlines', () => {
    assert.equal(sanitizeLegalTitle('A\nB'), 'A B');
  });

  it('validates doc ids', () => {
    assert.equal(isLegalDocId('datenschutz'), true);
    assert.equal(isLegalDocId('impressum'), true);
    assert.equal(isLegalDocId('../etc'), false);
    assert.equal(isLegalDocId('cookies'), false);
  });
});

describe('safeId', () => {
  it('accepts firebase-like ids', () => {
    assert.equal(isSafeFirestoreId('AbCdEfGhIjKlMnOpQrStUvWxYz12'), true);
  });

  it('rejects path injection', () => {
    assert.equal(isSafeFirestoreId('../users'), false);
    assert.equal(isSafeFirestoreId('a/b'), false);
    assert.equal(isSafeFirestoreId('short'), false);
  });
});
