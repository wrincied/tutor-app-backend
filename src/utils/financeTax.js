/** Ориентировочные налоговые оценки для режимов tutor-app (не декларация). */

const { normalizeTaxMode, isTaxModeConfigured } = require('./userProfile');

/** Австрийские прогрессивные ставки подоходного налога (оценка для self-employed). */
const AUSTRIAN_INCOME_TAX_BRACKETS = [
  { limit: 12816, rate: 0.0 },
  { limit: 20818, rate: 0.2 },
  { limit: 34513, rate: 0.3 },
  { limit: 66612, rate: 0.41 },
  { limit: 99266, rate: 0.48 },
  { limit: Infinity, rate: 0.5 },
];

/**
 * Упрощённая шкала немецкого ESt (оценка для Kleinunternehmer).
 * Grundfreibetrag ~11_604, затем 14%…42% — грубая аппроксимация сегментами.
 */
const GERMAN_INCOME_TAX_BRACKETS = [
  { limit: 11604, rate: 0.0 },
  { limit: 17005, rate: 0.14 },
  { limit: 66760, rate: 0.24 },
  { limit: 277825, rate: 0.42 },
  { limit: Infinity, rate: 0.45 },
];

const DEFAULT_SOCIAL_INSURANCE_RATE = 0.1812;
const DE_SOLIDARITY_SURCHARGE_RATE = 0.055;
const PL_RYCZALT_RATE = 0.085;
const RU_USN_RATE = 0.06;
const BY_IP_RATE = 0.16;
const KZ_IP_RATE = 0.03;
/** UA ФОП 3 група без ПДВ — типовая ставка 5% от доходу. */
const UA_FOP3_RATE = 0.05;

function taxFromBrackets(taxBase, brackets) {
  let tax = 0;
  let previousLimit = 0;
  let rest = Math.max(0, taxBase);

  for (const bracket of brackets) {
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

function austrianIncomeTax(taxBase) {
  return taxFromBrackets(taxBase, AUSTRIAN_INCOME_TAX_BRACKETS);
}

function germanIncomeTax(taxBase) {
  const est = taxFromBrackets(taxBase, GERMAN_INCOME_TAX_BRACKETS);
  return est + est * DE_SOLIDARITY_SURCHARGE_RATE;
}

function projectionResult({
  mode,
  socialInsuranceRate = 0,
  socialInsurance = 0,
  taxableBase = 0,
  incomeTax = 0,
  netProfit,
}) {
  return {
    mode,
    socialInsuranceRate,
    socialInsurance,
    taxableBase,
    incomeTax,
    netProfit,
  };
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

function flatRevenueTax(mode, rate, grossProfit, totalIncome) {
  const revenue = Math.max(0, totalIncome);
  const incomeTax = revenue * rate;
  return projectionResult({
    mode,
    socialInsuranceRate: 0,
    socialInsurance: 0,
    taxableBase: revenue,
    incomeTax,
    netProfit: grossProfit - incomeTax,
  });
}

function flatProfitTax(mode, rate, grossProfit) {
  const taxableBase = Math.max(0, grossProfit);
  const incomeTax = taxableBase * rate;
  return projectionResult({
    mode,
    socialInsuranceRate: 0,
    socialInsurance: 0,
    taxableBase,
    incomeTax,
    netProfit: grossProfit - incomeTax,
  });
}

/**
 * Универсальная оценка Нетто по налоговому режиму.
 * @param {string} taxMode
 * @param {{ grossProfit: number, totalIncome?: number }} amounts
 */
function computeTaxProjection(taxMode, { grossProfit = 0, totalIncome = 0 } = {}) {
  const mode = normalizeTaxMode(taxMode);
  if (!isTaxModeConfigured(mode)) {
    return null;
  }

  const gross = Number(grossProfit) || 0;
  const income = Number(totalIncome) || 0;

  switch (mode) {
    case 'at-self-employed': {
      const at = computeAustriaSelfEmployedProjection(gross);
      return projectionResult({ mode, ...at });
    }
    case 'de-kleinunternehmer': {
      const taxableBase = Math.max(0, gross);
      const incomeTax = germanIncomeTax(taxableBase);
      return projectionResult({
        mode,
        socialInsuranceRate: 0,
        socialInsurance: 0,
        taxableBase,
        incomeTax,
        netProfit: gross - incomeTax,
      });
    }
    case 'pl-ryczalt':
      return flatRevenueTax(mode, PL_RYCZALT_RATE, gross, income);
    case 'ru-usn':
    case 'ru-ip':
      return flatRevenueTax(mode, RU_USN_RATE, gross, income);
    case 'by-ip':
      return flatProfitTax(mode, BY_IP_RATE, gross);
    case 'kz-ip':
      return flatRevenueTax(mode, KZ_IP_RATE, gross, income);
    case 'ua-fop3':
      return flatRevenueTax(mode, UA_FOP3_RATE, gross, income);
    default:
      return null;
  }
}

module.exports = {
  AUSTRIAN_INCOME_TAX_BRACKETS,
  GERMAN_INCOME_TAX_BRACKETS,
  DEFAULT_SOCIAL_INSURANCE_RATE,
  DE_SOLIDARITY_SURCHARGE_RATE,
  PL_RYCZALT_RATE,
  RU_USN_RATE,
  BY_IP_RATE,
  KZ_IP_RATE,
  UA_FOP3_RATE,
  austrianIncomeTax,
  germanIncomeTax,
  computeAustriaSelfEmployedProjection,
  computeTaxProjection,
};
