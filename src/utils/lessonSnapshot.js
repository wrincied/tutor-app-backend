/** Снапшот ставки урока: lesson_price = ставка за час, lesson_currency = валюта на момент фиксации. */

const ALLOWED_CURRENCY = new Set(['BYN', 'PLN', 'EUR', 'USD', 'RUB']);

function priceSnapshotFromStudent(studentData) {
  const ratePerHour = Number(studentData?.rate_per_hour);
  const lesson_price =
    Number.isNaN(ratePerHour) || ratePerHour < 0 ? 0 : ratePerHour;
  const rawCurrency = studentData?.rate_currency;
  const lesson_currency = ALLOWED_CURRENCY.has(rawCurrency) ? rawCurrency : 'EUR';
  return { lesson_price, lesson_currency };
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

/** Выручка по снапшоту (ставка × часы или legacy lesson_rate), без фильтра по статусу. */
function lessonRevenueFromSnapshot(lessonData) {
  const durationMinutes = Number(lessonData.lesson_duration ?? 60);
  const hours = Math.max(0, durationMinutes) / 60;
  const ratePerHour = Number(lessonData.lesson_price);
  if (!Number.isNaN(ratePerHour) && ratePerHour > 0) {
    return ratePerHour * hours;
  }
  /** Legacy: lesson_rate как фиксированная сумма за урок */
  const legacyTotal = Number(lessonData.lesson_rate);
  if (!Number.isNaN(legacyTotal) && legacyTotal > 0) {
    return legacyTotal;
  }
  return 0;
}

/** Доход по завершённому уроку: ставка-снапшот × часы. */
function lessonIncomeFromSnapshot(lessonData) {
  if (normalizeLessonStatus(lessonData.status) !== 'completed') {
    return 0;
  }
  return lessonRevenueFromSnapshot(lessonData);
}

/** Плановая выручка по запланированному уроку. */
function lessonScheduledRevenueFromSnapshot(lessonData) {
  if (normalizeLessonStatus(lessonData.status) !== 'scheduled') {
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
  if (hasValidPrice && hasCurrency && hasTimezone) {
    return lesson;
  }
  if (!lesson.student_id || !studentById.has(lesson.student_id)) {
    return {
      ...lesson,
      lesson_price: hasValidPrice ? priceNum : 0,
      lesson_currency: hasCurrency ? lesson.lesson_currency : 'EUR',
      student_timezone: hasTimezone ? lesson.student_timezone : 'UTC',
    };
  }
  return {
    ...lesson,
    ...studentSnapshotFromStudent(studentById.get(lesson.student_id)),
  };
}

module.exports = {
  ALLOWED_CURRENCY,
  priceSnapshotFromStudent,
  studentSnapshotFromStudent,
  normalizeLessonStatus,
  isCompletedStatus,
  lessonRevenueFromSnapshot,
  lessonIncomeFromSnapshot,
  lessonScheduledRevenueFromSnapshot,
  enrichLessonSnapshot,
};
