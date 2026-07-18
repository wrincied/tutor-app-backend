const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  austrianIncomeTax,
  germanIncomeTax,
  computeAustriaSelfEmployedProjection,
  computeTaxProjection,
  PL_RYCZALT_RATE,
  RU_USN_RATE,
  BY_IP_RATE,
  KZ_IP_RATE,
  UA_FOP3_RATE,
  DE_SOLIDARITY_SURCHARGE_RATE,
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

describe('computeTaxProjection', () => {
  it('returns null for unset tax mode', () => {
    assert.equal(computeTaxProjection('none', { grossProfit: 1000, totalIncome: 1000 }), null);
    assert.equal(computeTaxProjection('', { grossProfit: 1000 }), null);
  });

  it('computes AT via shared austria helper', () => {
    const tax = computeTaxProjection('at-self-employed', {
      grossProfit: 20000,
      totalIncome: 22000,
    });
    const at = computeAustriaSelfEmployedProjection(20000);
    assert.equal(tax.mode, 'at-self-employed');
    assert.equal(tax.netProfit, at.netProfit);
    assert.equal(tax.socialInsuranceRate, 0.1812);
  });

  it('computes DE Kleinunternehmer with ESt + Soli, no social', () => {
    const grossProfit = 30000;
    const tax = computeTaxProjection('de-kleinunternehmer', {
      grossProfit,
      totalIncome: 35000,
    });
    const expectedTax = germanIncomeTax(grossProfit);
    assert.equal(tax.mode, 'de-kleinunternehmer');
    assert.equal(tax.socialInsurance, 0);
    assert.equal(tax.incomeTax, expectedTax);
    assert.equal(tax.netProfit, grossProfit - expectedTax);
    assert.ok(expectedTax > austrianIncomeTax(0));
    assert.ok(DE_SOLIDARITY_SURCHARGE_RATE > 0);
  });

  it('computes PL ryczałt on revenue, net from gross', () => {
    const tax = computeTaxProjection('pl-ryczalt', {
      grossProfit: 8000,
      totalIncome: 10000,
    });
    assert.equal(tax.mode, 'pl-ryczalt');
    assert.equal(tax.taxableBase, 10000);
    assert.equal(tax.incomeTax, 10000 * PL_RYCZALT_RATE);
    assert.equal(tax.netProfit, 8000 - 10000 * PL_RYCZALT_RATE);
  });

  it('computes RU USN 6% on revenue', () => {
    const tax = computeTaxProjection('ru-usn', {
      grossProfit: 9000,
      totalIncome: 10000,
    });
    assert.equal(tax.incomeTax, 10000 * RU_USN_RATE);
    assert.equal(tax.netProfit, 9000 - 10000 * RU_USN_RATE);
  });

  it('computes RU IP like USN 6%', () => {
    const tax = computeTaxProjection('ru-ip', {
      grossProfit: 5000,
      totalIncome: 5000,
    });
    assert.equal(tax.mode, 'ru-ip');
    assert.equal(tax.incomeTax, 5000 * RU_USN_RATE);
    assert.equal(tax.netProfit, 5000 - 5000 * RU_USN_RATE);
  });

  it('computes BY IP 16% on profit', () => {
    const tax = computeTaxProjection('by-ip', {
      grossProfit: 10000,
      totalIncome: 12000,
    });
    assert.equal(tax.taxableBase, 10000);
    assert.equal(tax.incomeTax, 10000 * BY_IP_RATE);
    assert.equal(tax.netProfit, 10000 - 10000 * BY_IP_RATE);
  });

  it('computes KZ IP 3% on revenue', () => {
    const tax = computeTaxProjection('kz-ip', {
      grossProfit: 9700,
      totalIncome: 10000,
    });
    assert.equal(tax.incomeTax, 10000 * KZ_IP_RATE);
    assert.equal(tax.netProfit, 9700 - 10000 * KZ_IP_RATE);
  });

  it('computes UA FOP3 5% on revenue', () => {
    const tax = computeTaxProjection('ua-fop3', {
      grossProfit: 9500,
      totalIncome: 10000,
    });
    assert.equal(tax.mode, 'ua-fop3');
    assert.equal(tax.incomeTax, 10000 * UA_FOP3_RATE);
    assert.equal(tax.netProfit, 9500 - 10000 * UA_FOP3_RATE);
  });

  it('keeps negative gross as net when tax base is zero', () => {
    const tax = computeTaxProjection('by-ip', {
      grossProfit: -500,
      totalIncome: 0,
    });
    assert.equal(tax.incomeTax, 0);
    assert.equal(tax.netProfit, -500);
  });
});
