const { db, FieldValue } = require('../firebase');
const {
  normalizeBillingType,
  normalizeRateUnit,
  packageDebitAmount,
  roundBalanceUnits,
} = require('./studentBilling');

const BILLABLE_STATUSES = new Set(['completed', 'missed', 'canceled']);

function uniqueDayKeys(list) {
  return [
    ...new Set(
      (list ?? [])
        .map((item) => String(item).slice(0, 10))
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)),
    ),
  ];
}

function isRecurringLesson(lesson) {
  return lesson?.isRecurring === true || Boolean(lesson?.rrule);
}

/** Completed/missed occurrence days on a series (YYYY-MM-DD), ascending. */
function billableOccurrenceDays(lesson) {
  return uniqueDayKeys([...(lesson?.completedDates || []), ...(lesson?.missedDates || [])]).sort();
}

function occurrenceScheduledAtIso(lesson, occurrenceDate) {
  const anchorMs = Date.parse(String(lesson?.scheduledAt || ''));
  const [y, m, d] = occurrenceDate.split('-').map(Number);
  if (Number.isFinite(anchorMs) && y && m && d) {
    const at = new Date(anchorMs);
    at.setUTCFullYear(y, m - 1, d);
    return at.toISOString();
  }
  return `${occurrenceDate}T12:00:00.000Z`;
}

/**
 * Date for topup preview / FIFO sort.
 * Recurring: use a completed/missed occurrence day — never the series anchor scheduledAt
 * (anchor can be a start day with no calendar card).
 */
function resolveUnpaidLessonScheduledAt(lesson, { preferNewest = true } = {}) {
  if (isRecurringLesson(lesson)) {
    const days = billableOccurrenceDays(lesson);
    if (days.length) {
      const day = preferNewest ? days[days.length - 1] : days[0];
      return occurrenceScheduledAtIso(lesson, day);
    }
  }
  if (lesson?.scheduledAt) {
    return String(lesson.scheduledAt);
  }
  if (lesson?.completed_at) {
    return String(lesson.completed_at);
  }
  return null;
}

function lessonScheduledMs(lesson) {
  const raw = resolveUnpaidLessonScheduledAt(lesson, { preferNewest: false }) || '';
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

function lessonKey(lesson) {
  return lesson._id || lesson.id;
}

/** Open debt in units (postpaid net of credit, package negative balance). */
function openDebtUnits(student, billingType) {
  if (billingType === 'postpaid') {
    const unpaid = Math.max(0, roundBalanceUnits(Number(student?.unpaid_lessons_count) || 0));
    const credit = Math.max(0, roundBalanceUnits(Number(student?.balance_lessons) || 0));
    return Math.max(0, roundBalanceUnits(unpaid - credit));
  }
  const balance = Number(student?.balance_lessons);
  const safeBalance = Number.isFinite(balance) ? balance : 0;
  return Math.max(0, roundBalanceUnits(-safeBalance));
}

/** Cover debt with oldest lessons first (postpaid / settle FIFO). */
function takeOldestCoveringDebt(candidatesOldestFirst, rateUnit, debt) {
  let remaining = debt;
  const out = [];
  for (const lesson of candidatesOldestFirst) {
    if (!(remaining > 0)) {
      break;
    }
    out.push(lesson);
    remaining = roundBalanceUnits(remaining - lessonUnits(lesson, rateUnit));
  }
  return out;
}

/** Cover package debt with newest debited lessons (matches debit order). */
function takeNewestCoveringDebt(candidatesOldestFirst, rateUnit, debt) {
  let remaining = debt;
  const unpaidNewestFirst = [];
  for (let i = candidatesOldestFirst.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const lesson = candidatesOldestFirst[i];
    unpaidNewestFirst.push(lesson);
    remaining = roundBalanceUnits(remaining - lessonUnits(lesson, rateUnit));
  }
  return sortLessonsOldestFirst(unpaidNewestFirst);
}

/**
 * Уроки, которые ещё числятся неоплаченными (долг пакета или постоплата).
 * Всегда капает по фактическому open debt — иначе Home показывает 4 урока при долге 0.5.
 * @param {{ includeOrphanFlags?: boolean }} [options]
 *   includeOrphanFlags: when debt is 0, still return unpaid_debt flags (settle cleanup).
 */
function selectUnpaidLessonsForSettlement(lessons, student, rateUnit, options = {}) {
  const billingType = normalizeBillingType(student?.billing_type);
  const debt = openDebtUnits(student, billingType);
  const includeOrphans = options.includeOrphanFlags === true;

  // unpaid_debt is the source of truth even on recurring series (status stays scheduled).
  const flagged = lessons.filter(
    (lesson) => lesson.unpaid_debt === true && !lesson.settled_by_payment_at,
  );

  if (billingType === 'postpaid') {
    const heuristic = lessons.filter(
      (lesson) =>
        BILLABLE_STATUSES.has(String(lesson.status)) &&
        lesson.billing_processed === true &&
        !lesson.settled_by_payment_at &&
        lesson.balance_debited !== true,
    );
    const byId = new Map();
    for (const lesson of [...flagged, ...heuristic]) {
      byId.set(lessonKey(lesson), lesson);
    }
    const merged = sortLessonsOldestFirst([...byId.values()]);
    if (debt > 0) {
      return takeOldestCoveringDebt(merged, rateUnit, debt);
    }
    if (includeOrphans && flagged.length) {
      return sortLessonsOldestFirst(flagged);
    }
    return [];
  }

  if (debt > 0) {
    if (flagged.length) {
      // Package open debt = newest debited lessons (balance went negative on the latest ones).
      // Settle still iterates this set oldest-first for payment order.
      return takeNewestCoveringDebt(sortLessonsOldestFirst(flagged), rateUnit, debt);
    }
    const candidates = sortLessonsOldestFirst(
      lessons.filter(
        (lesson) =>
          BILLABLE_STATUSES.has(String(lesson.status)) &&
          lesson.balance_debited === true &&
          !lesson.settled_by_payment_at,
      ),
    );
    return takeNewestCoveringDebt(candidates, rateUnit, debt);
  }

  if (includeOrphans && flagged.length) {
    return sortLessonsOldestFirst(flagged);
  }

  return [];
}

/**
 * Закрывает неоплаченные уроки FIFO на сумму units (старые первыми).
 * Postpaid: учитывает уже накопленный credit в balance_lessons; остаток снова кладётся в credit.
 * После полного погашения долга снимает оставшиеся orphan unpaid_debt флаги.
 * @returns {{ settledLessonIds: string[], settledUnits: number, remainingCredit: number }}
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
    return { settledLessonIds: [], settledUnits: 0, remainingCredit: 0 };
  }

  const rateUnit = normalizeRateUnit(rateUnitRaw ?? student?.rate_unit);
  const billingType = normalizeBillingType(student?.billing_type);
  const existingCredit =
    billingType === 'postpaid'
      ? Math.max(0, roundBalanceUnits(Number(student?.balance_lessons) || 0))
      : 0;
  let left = roundBalanceUnits(added + existingCredit);

  const snap = await db.collection('lessons').where('student_id', '==', studentId).get();
  const lessons = snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
  const unpaid = selectUnpaidLessonsForSettlement(lessons, student, rateUnit, {
    includeOrphanFlags: true,
  });

  const settledLessonIds = [];
  let settledUnits = 0;
  const batch = db.batch();
  let writes = 0;
  const paidAt = paidAtIso || new Date().toISOString();

  let debtLeft =
    billingType === 'postpaid'
      ? Math.max(0, roundBalanceUnits(Number(student?.unpaid_lessons_count) || 0))
      : Math.max(0, roundBalanceUnits(-(Number(student?.balance_lessons) || 0)));
  const useDebtCap = debtLeft > 0;

  for (const lesson of unpaid) {
    if (left <= 0) {
      break;
    }
    const fullNeed = lessonUnits(lesson, rateUnit);
    const need = useDebtCap ? roundBalanceUnits(Math.min(fullNeed, debtLeft)) : fullNeed;
    if (need <= 0 || left + 1e-9 < need) {
      // Не хватает на оставшийся долг по уроку — остаток остаётся кредитом (postpaid).
      break;
    }
    batch.update(lesson.ref, {
      balance_debited: true,
      billing_processed: true,
      balance_units_debited: fullNeed,
      unpaid_debt: false,
      settled_by_payment_at: paidAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writes += 1;
    settledLessonIds.push(lesson.id);
    settledUnits = roundBalanceUnits(settledUnits + need);
    left = roundBalanceUnits(left - need);
    if (useDebtCap) {
      debtLeft = roundBalanceUnits(debtLeft - need);
      if (!(debtLeft > 0)) {
        break;
      }
    }
  }

  // Open debt fully covered (or was already 0): drop leftover unpaid_debt so Home matches Students.
  const settledSet = new Set(settledLessonIds);
  if (!(debtLeft > 0)) {
    for (const lesson of lessons) {
      if (settledSet.has(lesson.id)) {
        continue;
      }
      if (lesson.unpaid_debt === true && !lesson.settled_by_payment_at) {
        batch.update(lesson.ref, {
          unpaid_debt: false,
          settled_by_payment_at: paidAt,
          updatedAt: FieldValue.serverTimestamp(),
        });
        writes += 1;
        settledLessonIds.push(lesson.id);
      }
    }
  }

  const studentRef = db.collection('students').doc(studentId);
  if (billingType === 'postpaid') {
    const currentUnpaid = Number(student?.unpaid_lessons_count) || 0;
    let nextUnpaid = Math.max(0, roundBalanceUnits(currentUnpaid - settledUnits));
    // Счётчик есть, а settleable-уроков нет (легаси) — уменьшаем счётчик на оплату.
    if (settledUnits === 0 && unpaid.length === 0 && currentUnpaid > 0) {
      nextUnpaid = Math.max(0, roundBalanceUnits(currentUnpaid - added));
      left = 0;
    }
    batch.update(studentRef, {
      unpaid_lessons_count: nextUnpaid,
      balance_lessons: left,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writes += 1;
  }

  if (writes > 0) {
    await batch.commit();
  }

  return { settledLessonIds, settledUnits, remainingCredit: left };
}

module.exports = {
  settleUnpaidLessonsOnTopup,
  selectUnpaidLessonsForSettlement,
  openDebtUnits,
  lessonUnits,
  resolveUnpaidLessonScheduledAt,
};
