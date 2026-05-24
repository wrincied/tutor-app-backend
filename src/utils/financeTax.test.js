const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  austrianIncomeTax,
  computeAustriaSelfEmployedProjection,
} = require('./financeTax');

describe('austrianIncomeTax', () => {
  it('returns 0 for zero or negative base', () => {
    assert.equal(austrianIncomeTax(0), 0);
    assert.equal(austrianIncomeTax(-500), 0);
  });

  it('applies 0% up to first bracket limit', () => {
    assert.equal(austrianIncomeTax(12816), 0);
  });

  it('applies 20% on amount above first bracket', () => {
    assert.equal(austrianIncomeTax(13816), 200);
  });

  it('applies multiple brackets', () => {
    const expected = 0 + 8002 * 0.2 + 4182 * 0.3;
    assert.equal(austrianIncomeTax(25000), expected);
  });

  it('handles high income in top bracket', () => {
    const tax = austrianIncomeTax(150000);
    assert.ok(tax > 50000, `expected substantial tax, got ${tax}`);
  });
});

describe('computeAustriaSelfEmployedProjection', () => {
  it('returns zeros for zero gross profit', () => {
    const result = computeAustriaSelfEmployedProjection(0);
    assert.deepEqual(result, {
      socialInsuranceRate: 0.1812,
      socialInsurance: 0,
      taxableBase: 0,
      incomeTax: 0,
      netProfit: 0,
    });
  });

  it('does not apply social insurance to negative gross profit', () => {
    const result = computeAustriaSelfEmployedProjection(-1000);
    assert.equal(result.socialInsurance, 0);
    assert.equal(result.taxableBase, 0);
    assert.equal(result.incomeTax, 0);
    assert.equal(result.netProfit, -1000);
  });

  it('computes full projection for positive gross profit', () => {
    const grossProfit = 20000;
    const result = computeAustriaSelfEmployedProjection(grossProfit);
    const expectedSocial = grossProfit * 0.1812;
    const expectedTaxable = grossProfit - expectedSocial;
    const expectedIncomeTax = austrianIncomeTax(expectedTaxable);

    assert.equal(result.socialInsurance, expectedSocial);
    assert.equal(result.taxableBase, expectedTaxable);
    assert.equal(result.incomeTax, expectedIncomeTax);
    assert.equal(result.netProfit, grossProfit - expectedSocial - expectedIncomeTax);
  });
});
