const {
  sanitizeLegalMarkdown,
  sanitizeLegalTitle,
  isLegalDocId,
  defaultLegalDoc,
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

  it('default datenschutz covers WKO checklist headings', () => {
    const doc = defaultLegalDoc('datenschutz');
    assert.ok(doc);
    assert.match(doc.title, /Datenschutz/i);
    const body = doc.body;
    for (const heading of [
      'Verantwortlicher',
      'Aufruf der Website',
      'Nutzerkonto',
      'CRM-Inhalte',
      'Stripe',
      'Telegram',
      'Cookies',
      'Empfänger',
      'Drittländer',
      'Speicherdauer',
      'Ihre Rechte',
      'Beschwerderecht',
      'Automatisierte Entscheidungsfindung',
    ]) {
      assert.match(body, new RegExp(heading));
    }
    assert.match(body, /support@simple4u\.at/);
    assert.match(body, /Arsen Mileuski/);
    assert.match(body, /Köflacher Gasse 9, Tür 218\.2/);
    assert.doesNotMatch(body, /\[Firmenname\]/);
  });

  it('default impressum includes GISA, Gewerbe wording and WKO Firmen A-Z', () => {
    const doc = defaultLegalDoc('impressum');
    assert.ok(doc);
    const body = doc.body;
    assert.match(body, /39994318/);
    assert.match(body, /Dienstleistungen in der automatischen Datenverarbeitung/);
    assert.match(body, /firmen\.wko\.at\/arsen-mileuski/);
    assert.match(body, /Tür 218\.2/);
    assert.match(body, /Magistrat der Stadt Graz/);
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
