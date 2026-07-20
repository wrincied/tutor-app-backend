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

function normalizeRateUnit(raw) {
  return String(raw ?? 'hour').trim().toLowerCase() === 'lesson' ? 'lesson' : 'hour';
}

function roundBalanceUnits(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Сколько единиц списать/начислить за урок:
 * lesson → 1 занятие; hour → duration/60 часов.
 */
function packageDebitAmount({ rateUnit, lessonDuration }) {
  if (normalizeRateUnit(rateUnit) === 'lesson') {
    return 1;
  }
  const minutes = Number(lessonDuration);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  return roundBalanceUnits(safe / 60);
}

function parseNonNegativeInt(raw, fallback = 0) {
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) {
    return fallback;
  }
  return Math.round(n);
}

/**
 * Top-up / ручной баланс: lesson = целое, hour = дробь (мин. 0.01).
 */
function parseBalanceAmount(raw, rateUnit, fallback = 0) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  if (normalizeRateUnit(rateUnit) === 'lesson') {
    return Math.round(n);
  }
  return roundBalanceUnits(n);
}

module.exports = {
  ALLOWED_BILLING_TYPES,
  normalizeBillingType,
  normalizeRateUnit,
  parseNonNegativeInt,
  parseBalanceAmount,
  packageDebitAmount,
  roundBalanceUnits,
};
