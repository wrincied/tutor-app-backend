/** Снапшот ставки урока: lesson_price + price_mode + валюта на момент фиксации. */

const ALLOWED_CURRENCY = new Set(['BYN', 'PLN', 'EUR', 'USD', 'RUB', 'KZT', 'UAH']);
const { normalizeRateUnit } = require('./studentBilling');

function normalizePriceMode(raw, rateUnit) {
  const mode = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (mode === 'fixed' || mode === 'lesson') {
    return 'fixed';
  }
  if (mode === 'hourly' || mode === 'hour') {
    return 'hourly';
  }
  return normalizeRateUnit(rateUnit) === 'lesson' ? 'fixed' : 'hourly';
}

function priceSnapshotFromStudent(studentData) {
  const ratePerHour = Number(studentData?.rate_per_hour);
  const lesson_price =
    Number.isNaN(ratePerHour) || ratePerHour < 0 ? 0 : ratePerHour;
  const rawCurrency = studentData?.rate_currency;
  const lesson_currency = ALLOWED_CURRENCY.has(rawCurrency) ? rawCurrency : 'EUR';
  const price_mode = normalizePriceMode(studentData?.price_mode, studentData?.rate_unit);
  return { lesson_price, lesson_currency, price_mode };
}

/** Снапшот ставки + регион (часовой пояс ученика на момент урока). */
function studentSnapshotFromStudent(studentData) {
  return {
    ...priceSnapshotFromStudent(studentData),
    student_timezone: studentData?.timezone
      ? String(studentData.timezone)
      : 'UTC',
  };
}

const KNOWN_LESSON_STATUS = new Set(['scheduled', 'completed', 'missed', 'canceled']);

function normalizeLessonStatus(status) {
  const raw = String(status ?? 'scheduled')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'planned' || raw === 'plan' || raw === 'geplant') {
    return 'scheduled';
  }
  if (raw === 'cancelled') {
    return 'canceled';
  }
  if (raw === 'done' || raw === 'finished') {
    return 'completed';
  }
  if (KNOWN_LESSON_STATUS.has(raw)) {
    return raw;
  }
  return 'scheduled';
}

function isCompletedStatus(status) {
  return normalizeLessonStatus(status) === 'completed';
}

/**
 * Выручка по снапшоту.
 * fixed  → lesson_price
 * hourly → lesson_price * (lesson_duration / 60)
 * legacy → lesson_rate как фиксированная сумма
 */
function lessonRevenueFromSnapshot(lessonData) {
  const price = Number(lessonData.lesson_price);
  if (!Number.isNaN(price) && price > 0) {
    const priceMode = normalizePriceMode(lessonData.price_mode, lessonData.rate_unit);
    if (priceMode === 'fixed') {
      return price;
    }
    const durationMinutes = Number(lessonData.lesson_duration ?? 60);
    const hours = Math.max(0, Number.isNaN(durationMinutes) ? 60 : durationMinutes) / 60;
    return price * hours;
  }
  /** Legacy: lesson_rate как фиксированная сумма за урок */
  const legacyTotal = Number(lessonData.lesson_rate);
  if (!Number.isNaN(legacyTotal) && legacyTotal > 0) {
    return legacyTotal;
  }
  return 0;
}

/** Доход по завершённому уроку. */
function lessonIncomeFromSnapshot(lessonData) {
  return lessonIncomeForStatus(lessonData, lessonData.status);
}

/** Плановая выручка по запланированному уроку. */
function lessonScheduledRevenueFromSnapshot(lessonData) {
  return lessonScheduledRevenueForStatus(lessonData, lessonData.status);
}

function lessonIncomeForStatus(lessonData, status) {
  if (normalizeLessonStatus(status) !== 'completed') {
    return 0;
  }
  return lessonRevenueFromSnapshot(lessonData);
}

function lessonScheduledRevenueForStatus(lessonData, status) {
  if (normalizeLessonStatus(status) !== 'scheduled') {
    return 0;
  }
  return lessonRevenueFromSnapshot(lessonData);
}

function enrichLessonSnapshot(lesson, studentById) {
  const priceNum = Number(lesson.lesson_price);
  const hasValidPrice =
    lesson.lesson_price !== undefined &&
    lesson.lesson_price !== null &&
    !Number.isNaN(priceNum) &&
    priceNum > 0;
  const hasCurrency = Boolean(lesson.lesson_currency);
  const hasTimezone = Boolean(lesson.student_timezone);
  const hasPriceMode = Boolean(lesson.price_mode);
  if (hasValidPrice && hasCurrency && hasTimezone && hasPriceMode) {
    return {
      ...lesson,
      price_mode: normalizePriceMode(lesson.price_mode),
    };
  }
  if (!lesson.student_id || !studentById.has(lesson.student_id)) {
    return {
      ...lesson,
      lesson_price: hasValidPrice ? priceNum : 0,
      lesson_currency: hasCurrency ? lesson.lesson_currency : 'EUR',
      student_timezone: hasTimezone ? lesson.student_timezone : 'UTC',
      price_mode: hasPriceMode
        ? normalizePriceMode(lesson.price_mode)
        : normalizePriceMode(null, lesson.rate_unit),
    };
  }
  const student = studentById.get(lesson.student_id);
  const snapshot = studentSnapshotFromStudent(student);
  return {
    ...lesson,
    lesson_price: hasValidPrice ? priceNum : snapshot.lesson_price,
    lesson_currency: hasCurrency ? lesson.lesson_currency : snapshot.lesson_currency,
    student_timezone: hasTimezone ? lesson.student_timezone : snapshot.student_timezone,
    price_mode: hasPriceMode ? normalizePriceMode(lesson.price_mode) : snapshot.price_mode,
  };
}

module.exports = {
  ALLOWED_CURRENCY,
  normalizePriceMode,
  priceSnapshotFromStudent,
  studentSnapshotFromStudent,
  normalizeLessonStatus,
  isCompletedStatus,
  lessonRevenueFromSnapshot,
  lessonIncomeFromSnapshot,
  lessonScheduledRevenueFromSnapshot,
  lessonIncomeForStatus,
  lessonScheduledRevenueForStatus,
  enrichLessonSnapshot,
};
