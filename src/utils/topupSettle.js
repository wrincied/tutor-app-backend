const { db, FieldValue } = require('../firebase');
const {
  normalizeBillingType,
  normalizeRateUnit,
  packageDebitAmount,
  roundBalanceUnits,
} = require('./studentBilling');

const BILLABLE_STATUSES = new Set(['completed', 'missed', 'canceled']);

function lessonScheduledMs(lesson) {
  const raw = lesson?.scheduledAt || lesson?.completed_at || '';
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function lessonUnits(lesson, rateUnit) {
  if (lesson?.balance_units_debited != null && Number(lesson.balance_units_debited) > 0) {
    return roundBalanceUnits(Number(lesson.balance_units_debited));
  }
  return packageDebitAmount({
    rateUnit,
    lessonDuration: lesson?.lesson_duration,
  });
}

function sortLessonsOldestFirst(lessons) {
  return [...lessons].sort((left, right) => lessonScheduledMs(left) - lessonScheduledMs(right));
}

/**
 * Уроки, которые ещё числятся неоплаченными (долг пакета или постоплата).
 * При отрицательном балансе: хвост долга = самые новые списанные уроки.
 */
function selectUnpaidLessonsForSettlement(lessons, student, rateUnit) {
  const billingType = normalizeBillingType(student?.billing_type);
  const flagged = lessons.filter(
    (lesson) =>
      BILLABLE_STATUSES.has(String(lesson.status)) &&
      lesson.unpaid_debt === true &&
      !lesson.settled_by_payment_at,
  );
  if (flagged.length) {
    return sortLessonsOldestFirst(flagged);
  }

  if (billingType === 'postpaid') {
    return sortLessonsOldestFirst(
      lessons.filter(
        (lesson) =>
          BILLABLE_STATUSES.has(String(lesson.status)) &&
          lesson.billing_processed === true &&
          !lesson.settled_by_payment_at &&
          lesson.balance_debited !== true,
      ),
    );
  }

  const balance = Number(student?.balance_lessons);
  const safeBalance = Number.isFinite(balance) ? balance : 0;
  const debt = Math.max(0, roundBalanceUnits(-safeBalance));

  if (debt > 0) {
    const candidates = sortLessonsOldestFirst(
      lessons.filter(
        (lesson) =>
          BILLABLE_STATUSES.has(String(lesson.status)) &&
          lesson.balance_debited === true &&
          !lesson.settled_by_payment_at,
      ),
    );
    let remaining = debt;
    const unpaidNewestFirst = [];
    for (let i = candidates.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const lesson = candidates[i];
      unpaidNewestFirst.push(lesson);
      remaining = roundBalanceUnits(remaining - lessonUnits(lesson, rateUnit));
    }
    return sortLessonsOldestFirst(unpaidNewestFirst);
  }

  return sortLessonsOldestFirst(
    lessons.filter(
      (lesson) =>
        BILLABLE_STATUSES.has(String(lesson.status)) &&
        lesson.billing_processed === true &&
        lesson.balance_debited !== true &&
        !lesson.settled_by_payment_at,
    ),
  );
}

/**
 * Закрывает неоплаченные уроки FIFO на сумму units (старые первыми).
 * @returns {{ settledLessonIds: string[], settledUnits: number }}
 */
async function settleUnpaidLessonsOnTopup({
  studentId,
  student,
  units,
  rateUnit: rateUnitRaw,
  paidAtIso,
}) {
  const added = roundBalanceUnits(units);
  if (!studentId || !(added > 0)) {
    return { settledLessonIds: [], settledUnits: 0 };
  }

  const rateUnit = normalizeRateUnit(rateUnitRaw ?? student?.rate_unit);
  const snap = await db.collection('lessons').where('student_id', '==', studentId).get();
  const lessons = snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
  const unpaid = selectUnpaidLessonsForSettlement(lessons, student, rateUnit);

  let left = added;
  const settledLessonIds = [];
  let settledUnits = 0;
  const batch = db.batch();
  let writes = 0;

  for (const lesson of unpaid) {
    if (left <= 0) {
      break;
    }
    const need = lessonUnits(lesson, rateUnit);
    if (need <= 0 || left + 1e-9 < need) {
      break;
    }
    batch.update(lesson.ref, {
      balance_debited: true,
      billing_processed: true,
      balance_units_debited: need,
      unpaid_debt: false,
      settled_by_payment_at: paidAtIso || new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    writes += 1;
    settledLessonIds.push(lesson.id);
    settledUnits = roundBalanceUnits(settledUnits + need);
    left = roundBalanceUnits(left - need);
  }

  const billingType = normalizeBillingType(student?.billing_type);
  const studentRef = db.collection('students').doc(studentId);
  if (billingType === 'postpaid' && settledUnits > 0) {
    const currentUnpaid = Number(student?.unpaid_lessons_count) || 0;
    const nextUnpaid = Math.max(0, roundBalanceUnits(currentUnpaid - settledUnits));
    batch.update(studentRef, {
      unpaid_lessons_count: nextUnpaid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writes += 1;
  }

  if (writes > 0) {
    await batch.commit();
  }

  return { settledLessonIds, settledUnits };
}

module.exports = {
  settleUnpaidLessonsOnTopup,
  selectUnpaidLessonsForSettlement,
  lessonUnits,
};
