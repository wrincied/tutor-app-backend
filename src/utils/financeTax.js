/** Австрийские прогрессивные ставки подоходного налога (оценка для self-employed). */
const AUSTRIAN_INCOME_TAX_BRACKETS = [
  { limit: 12816, rate: 0.0 },
  { limit: 20818, rate: 0.2 },
  { limit: 34513, rate: 0.3 },
  { limit: 66612, rate: 0.41 },
  { limit: 99266, rate: 0.48 },
  { limit: Infinity, rate: 0.5 },
];

const DEFAULT_SOCIAL_INSURANCE_RATE = 0.1812;

function austrianIncomeTax(taxBase) {
  let tax = 0;
  let previousLimit = 0;
  let rest = Math.max(0, taxBase);

  for (const bracket of AUSTRIAN_INCOME_TAX_BRACKETS) {
    if (rest <= 0) {
      break;
    }
    const segmentCap = bracket.limit - previousLimit;
    const segment = Math.min(rest, segmentCap);
    tax += segment * bracket.rate;
    rest -= segment;
    previousLimit = bracket.limit;
  }

  return tax;
}

/** Соц. взнос, налоговая база, подоходный налог и чистая прибыль (AT self-employed). */
function computeAustriaSelfEmployedProjection(grossProfit, socialInsuranceRate = DEFAULT_SOCIAL_INSURANCE_RATE) {
  const socialInsurance = Math.max(0, grossProfit) * socialInsuranceRate;
  const taxableBase = Math.max(0, grossProfit - socialInsurance);
  const incomeTax = austrianIncomeTax(taxableBase);
  const netProfit = grossProfit - socialInsurance - incomeTax;

  return {
    socialInsuranceRate,
    socialInsurance,
    taxableBase,
    incomeTax,
    netProfit,
  };
}

module.exports = {
  AUSTRIAN_INCOME_TAX_BRACKETS,
  DEFAULT_SOCIAL_INSURANCE_RATE,
  austrianIncomeTax,
  computeAustriaSelfEmployedProjection,
};
