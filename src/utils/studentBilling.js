const ALLOWED_BILLING_TYPES = new Set(['package', 'postpaid']);

function normalizeBillingType(raw) {
  const value = String(raw ?? 'package')
    .trim()
    .toLowerCase();
  if (value === 'postpaid' || value === 'per_lesson' || value === 'single') {
    return 'postpaid';
  }
  return 'package';
}

function parseNonNegativeInt(raw, fallback = 0) {
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) {
    return fallback;
  }
  return Math.round(n);
}

function normalizeRateUnit(raw) {
  return String(raw ?? 'hour').trim().toLowerCase() === 'lesson' ? 'lesson' : 'hour';
}

module.exports = {
  ALLOWED_BILLING_TYPES,
  normalizeBillingType,
  normalizeRateUnit,
  parseNonNegativeInt,
};
