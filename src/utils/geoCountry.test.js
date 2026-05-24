const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { countryFromHeaders } = require('./geoCountry');

describe('geoCountry', () => {
  it('reads country from CDN headers', () => {
    const req = { headers: { 'cf-ipcountry': 'PL' } };
    assert.equal(countryFromHeaders(req), 'PL');
  });

  it('ignores unknown country codes', () => {
    const req = { headers: { 'cf-ipcountry': 'ZZ' } };
    assert.equal(countryFromHeaders(req), null);
  });
});
