const { db, FieldValue } = require('../firebase');
const { normalizeLessonStatus, isCompletedStatus } = require('../utils/lessonSnapshot');
const { normalizeBillingType, packageDebitAmount, normalizeRateUnit } = require('../utils/studentBilling');
const { appendStudentBalanceLog } = require('../utils/activityLog');
const { LESSON_BILLING_BUFFER_MS } = require('../utils/lessonBillingConstants');
const { lessonOccurrenceIntervals, dayKeyFromDate } = require('../utils/lessonRecurrence');
const { notifyLowPackageBalanceIfNeeded } = require('../utils/lowBalanceNotify');

function normalizeOccurrenceDate(raw) {
  if (!raw) {
    return null;
  }
  const value = String(raw).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function uniqueDates(list) {
  return [...new Set((list ?? []).map((item) => String(item).slice(0, 10)).filter(Boolean))];
}

async function occurrenceBalanceDebited(lessonId, occurrenceDate) {
  const date = String(occurrenceDate || '').slice(0, 10);
  if (!lessonId || !date) {
    return false;
  }
  // Requires composite index (lessonId, occurrenceDate) — deploy indexes before this query.
  const snap = await db
    .collection('balance_logs')
    .where('lessonId', '==', lessonId)
    .where('occurrenceDate', '==', date)
    .limit(1)
    .get();
  return !snap.empty;
}

function appendBalanceLogEntry(batch, {
  tutorId,
  studentId,
  studentName,
  lessonId,
  amount,
  reason,
  occurrenceDate,
}) {
  const logRef = db.collection('balance_logs').doc();
  batch.set(logRef, {
    tutor: tutorId,
    studentId,
    lessonId,
    occurrenceDate: occurrenceDate ?? null,
    amount,
    reason,
    createdAt: FieldValue.serverTimestamp(),
  });
  appendStudentBalanceLog(batch, {
    tutorId,
    studentId,
    studentName,
    lessonId,
    amount,
    reason,
  });
}

function debitPackageOccurrence(batch, {
  tutorId,
  studentRef,
  lessonRef,
  studentId,
  studentName,
  lessonId,
  occurrenceDate,
  amount = 1,
  currentBalance,
  allowNegative = true,
  reason = 'lesson_completed_occurrence',
}) {
  const units = Math.round(Number(amount) * 100) / 100 || 1;
  const current = Number(currentBalance);
  const hasCurrent = Number.isFinite(current);
  const safeCurrent = hasCurrent ? current : 0;

  if (allowNegative) {
    const next = Math.round((safeCurrent - units) * 100) / 100;
    batch.update(studentRef, {
      balance_lessons: FieldValue.increment(-units),
      updatedAt: FieldValue.serverTimestamp(),
    });
    appendBalanceLogEntry(batch, {
      tutorId,
      studentId,
      studentName,
      lessonId,
      amount: -units,
      reason,
      occurrenceDate,
    });
    batch.update(lessonRef, {
      // Negative package balance = debt; keep unpaid flag until top-up settles FIFO.
      unpaid_debt: next < 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { debited: true, amount: units, unpaidDebt: next < 0 };
  }

  const available = Math.max(0, safeCurrent);
  const actualDebit = Math.round(Math.min(units, available) * 100) / 100;
  const next = Math.round((safeCurrent - actualDebit) * 100) / 100;

  if (actualDebit > 0) {
    batch.update(studentRef, {
      balance_lessons: next,
      updatedAt: FieldValue.serverTimestamp(),
    });
    appendBalanceLogEntry(batch, {
      tutorId,
      studentId,
      studentName,
      lessonId,
      amount: -actualDebit,
      reason,
      occurrenceDate,
    });
  }
  batch.update(lessonRef, {
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { debited: actualDebit > 0, amount: actualDebit };
}

function creditPackageOccurrence(batch, {
  tutorId,
  studentRef,
  lessonRef,
  studentId,
  studentName,
  lessonId,
  occurrenceDate,
  amount = 1,
}) {
  const units = Math.round(Number(amount) * 100) / 100 || 1;
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(units),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLogEntry(batch, {
    tutorId,
    studentId,
    studentName,
    lessonId,
    amount: units,
    reason: 'lesson_occurrence_uncompleted_refund',
    occurrenceDate,
  });
}

function debitPostpaidOccurrence(batch, {
  tutorId,
  studentRef,
  lessonRef,
  studentId,
  studentName,
  lessonId,
  occurrenceDate,
  amount = 1,
  reason = 'lesson_completed_postpaid_occurrence',
}) {
  const units = Math.round(Number(amount) * 100) / 100 || 1;
  batch.update(studentRef, {
    unpaid_lessons_count: FieldValue.increment(units),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    billing_processed: true,
    balance_debited: false,
    unpaid_debt: true,
    settled_by_payment_at: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLogEntry(batch, {
    tutorId,
    studentId,
    studentName,
    lessonId,
    amount: units,
    reason,
    occurrenceDate,
  });
}

function creditPostpaidOccurrence(batch, {
  tutorId,
  studentRef,
  lessonRef,
  studentId,
  studentName,
  lessonId,
  occurrenceDate,
  amount = 1,
}) {
  const units = Math.round(Number(amount) * 100) / 100 || 1;
  batch.update(studentRef, {
    unpaid_lessons_count: FieldValue.increment(-units),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLogEntry(batch, {
    tutorId,
    studentId,
    studentName,
    lessonId,
    amount: -units,
    reason: 'lesson_occurrence_uncompleted_postpaid',
    occurrenceDate,
  });
}

function occurrenceDebitUnits(studentData, lesson) {
  return packageDebitAmount({
    rateUnit: normalizeRateUnit(studentData?.rate_unit),
    lessonDuration: lesson?.lesson_duration,
  });
}

/**
 * Смена статуса одного вхождения серии (completed / scheduled / missed / canceled).
 */
function occurrenceEndMs(lesson, occurrenceDate) {
  const [y, m, d] = occurrenceDate.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0);
  const dayEnd = new Date(y, m - 1, d, 23, 59, 59, 999);
  // Перенесённое вхождение может уехать на другой день, поэтому ищем с запасом по ключу.
  const searchStart = new Date(dayStart);
  searchStart.setDate(searchStart.getDate() - 7);
  const searchEnd = new Date(dayEnd);
  searchEnd.setDate(searchEnd.getDate() + 7);
  const intervals = lessonOccurrenceIntervals(lesson, searchStart, searchEnd);
  const match = intervals.find((interval) => interval.occurrenceDate === occurrenceDate);
  if (match) {
    return match.end;
  }
  const duration = Number(lesson.lesson_duration) || 60;
  return dayStart.getTime() + duration * 60_000;
}

/**
 * Списание по вхождению серии, если урок уже в completedDates и прошло время + буфер.
 */
async function debitRecurringOccurrenceIfDue({
  tutorId,
  lessonRef,
  existing,
  occurrenceDate,
  studentSnap,
  studentRef,
  now = Date.now(),
}) {
  const lessonId = lessonRef.id;
  const completedDates = uniqueDates(existing.completedDates);
  if (!completedDates.includes(occurrenceDate)) {
    return { skipped: true, reason: 'not_completed' };
  }
  if (await occurrenceBalanceDebited(lessonId, occurrenceDate)) {
    return { skipped: true, reason: 'already_debited' };
  }
  if (now < occurrenceEndMs(existing, occurrenceDate) + LESSON_BILLING_BUFFER_MS) {
    return { skipped: true, reason: 'buffer_pending' };
  }
  if (studentSnap?.data()?.auto_debit_enabled === false) {
    return { skipped: true, reason: 'auto_debit_disabled' };
  }

  const billingType = normalizeBillingType(studentSnap?.data()?.billing_type);
  const studentId = existing.student_id;
  const studentName = studentSnap?.data()?.name ?? existing.student_name;
  const units = occurrenceDebitUnits(studentSnap?.data(), existing);
  const batch = db.batch();

  if (billingType === 'package') {
    debitPackageOccurrence(batch, {
      tutorId,
      studentRef,
      lessonRef,
      studentId,
      studentName,
      lessonId,
      occurrenceDate,
      amount: units,
      currentBalance: studentSnap?.data()?.balance_lessons,
    });
  } else {
    debitPostpaidOccurrence(batch, {
      tutorId,
      studentRef,
      lessonRef,
      studentId,
      studentName,
      lessonId,
      occurrenceDate,
      amount: units,
    });
  }
  await batch.commit();
  if (billingType === 'package') {
    const freshSnap = await studentRef.get();
    if (freshSnap.exists) {
      await notifyLowPackageBalanceIfNeeded(studentId, {
        tutorId,
        student: { _id: studentId, ...freshSnap.data() },
      });
    }
  }
  return { debited: true, occurrenceDate };
}

function occurrenceStatusArrays(existing) {
  return {
    completedDates: uniqueDates(existing.completedDates),
    missedDates: uniqueDates(existing.missedDates),
    canceledDates: uniqueDates(existing.canceledDates),
    exdates: uniqueDates(existing.exdates),
  };
}

/** Keep occurrence visible: missed/canceled use date lists, not exdates (exdates = deleted). */
function withOccurrenceStatusDates(existing, occurrenceDate, nextStatus) {
  const { completedDates, missedDates, canceledDates, exdates } = occurrenceStatusArrays(existing);
  const without = (list) => list.filter((date) => date !== occurrenceDate);
  if (nextStatus === 'completed') {
    return {
      completedDates: uniqueDates([...without(completedDates), occurrenceDate]),
      missedDates: without(missedDates),
      canceledDates: without(canceledDates),
      exdates: without(exdates),
    };
  }
  if (nextStatus === 'missed') {
    return {
      completedDates: without(completedDates),
      missedDates: uniqueDates([...without(missedDates), occurrenceDate]),
      canceledDates: without(canceledDates),
      exdates: without(exdates),
    };
  }
  if (nextStatus === 'canceled') {
    return {
      completedDates: without(completedDates),
      missedDates: without(missedDates),
      canceledDates: uniqueDates([...without(canceledDates), occurrenceDate]),
      exdates: without(exdates),
    };
  }
  // scheduled / restore
  return {
    completedDates: without(completedDates),
    missedDates: without(missedDates),
    canceledDates: without(canceledDates),
    exdates: without(exdates),
  };
}

function hadOccurrenceBillingMarker(existing, occurrenceDate) {
  const { completedDates, missedDates, canceledDates, exdates } =
    occurrenceStatusArrays(existing);
  return (
    completedDates.includes(occurrenceDate) ||
    missedDates.includes(occurrenceDate) ||
    canceledDates.includes(occurrenceDate) ||
    exdates.includes(occurrenceDate)
  );
}

async function applyRecurringOccurrenceStatus({
  tutorId,
  lessonRef,
  existing,
  occurrenceDate,
  nextStatus,
  shouldDeduct,
  shouldRefund = false,
  autoDebitEnabled,
  studentSnap,
  studentRef,
  billImmediately = true,
}) {
  const normalizedStatus = normalizeLessonStatus(nextStatus);
  const { completedDates } = occurrenceStatusArrays(existing);
  const wasCompleted = completedDates.includes(occurrenceDate);
  const billingType = normalizeBillingType(studentSnap?.data()?.billing_type);
  const lessonId = lessonRef.id;
  const units = occurrenceDebitUnits(studentSnap?.data(), existing);

  const batch = db.batch();
  const studentId = existing.student_id;
  const studentName = studentSnap?.data()?.name ?? existing.student_name;

  if (isCompletedStatus(normalizedStatus) && wasCompleted) {
    const alreadyDebited = await occurrenceBalanceDebited(lessonId, occurrenceDate);
    if (alreadyDebited) {
      return { skipped: true, alreadyCompleted: true, occurrenceDate };
    }
  }

  if (isCompletedStatus(normalizedStatus) && !wasCompleted) {
    if (autoDebitEnabled === false) {
      const err = new Error('Auto debit is disabled for this student');
      err.statusCode = 400;
      throw err;
    }
    const dates = withOccurrenceStatusDates(existing, occurrenceDate, 'completed');
    batch.update(lessonRef, {
      ...dates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (billImmediately) {
      if (billingType === 'package') {
        debitPackageOccurrence(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId,
          occurrenceDate,
          amount: units,
          currentBalance: studentSnap?.data()?.balance_lessons,
        });
      } else {
        debitPostpaidOccurrence(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId,
          occurrenceDate,
          amount: units,
        });
      }
    }
    await batch.commit();
    return { completed: true, occurrenceDate, billingDeferred: !billImmediately };
  }

  if (isCompletedStatus(normalizedStatus) && wasCompleted) {
    if (autoDebitEnabled === false) {
      const err = new Error('Auto debit is disabled for this student');
      err.statusCode = 400;
      throw err;
    }
    const dates = withOccurrenceStatusDates(existing, occurrenceDate, 'completed');
    batch.update(lessonRef, {
      ...dates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (billingType === 'package') {
      debitPackageOccurrence(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        studentName,
        lessonId,
        occurrenceDate,
        amount: units,
        currentBalance: studentSnap?.data()?.balance_lessons,
      });
    } else {
      debitPostpaidOccurrence(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        studentName,
        lessonId,
        occurrenceDate,
        amount: units,
      });
    }
    await batch.commit();
    return { completed: true, occurrenceDate, repaired: true };
  }

  if (!isCompletedStatus(normalizedStatus) && wasCompleted && normalizedStatus === 'scheduled') {
    const dates = withOccurrenceStatusDates(existing, occurrenceDate, 'scheduled');
    batch.update(lessonRef, {
      ...dates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (billingType === 'package') {
      creditPackageOccurrence(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        studentName,
        lessonId: lessonRef.id,
        occurrenceDate,
        amount: units,
      });
    } else {
      creditPostpaidOccurrence(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        studentName,
        lessonId: lessonRef.id,
        occurrenceDate,
        amount: units,
      });
    }
    await batch.commit();
    return { uncompleted: true, occurrenceDate };
  }

  if (normalizedStatus === 'missed' || normalizedStatus === 'canceled') {
    const dates = withOccurrenceStatusDates(existing, occurrenceDate, normalizedStatus);
    batch.update(lessonRef, {
      ...dates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });

    const alreadyDebited = await occurrenceBalanceDebited(lessonId, occurrenceDate);
    const deductReason =
      normalizedStatus === 'canceled'
        ? 'lesson_canceled_deduct_occurrence'
        : 'lesson_missed_deduct_occurrence';

    if (shouldDeduct === true && !alreadyDebited) {
      console.log('[billing] occurrence missed/canceled deduct', {
        lessonId: lessonRef.id,
        occurrenceDate,
        normalizedStatus,
        billingType,
        units,
        balanceBefore: studentSnap?.data()?.balance_lessons,
        studentId,
      });
      if (billingType === 'package') {
        const debitResult = debitPackageOccurrence(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId: lessonRef.id,
          occurrenceDate,
          amount: units,
          currentBalance: studentSnap?.data()?.balance_lessons,
          // Явный выбор «списать» — разрешаем уход в минус (долг).
          allowNegative: true,
          reason: deductReason,
        });
        console.log('[billing] occurrence package debit result', debitResult);
      } else {
        debitPostpaidOccurrence(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId: lessonRef.id,
          occurrenceDate,
          amount: units,
          reason: deductReason,
        });
        console.log('[billing] occurrence postpaid unpaid increment', { units });
      }
      await batch.commit();
      return { marked: normalizedStatus, occurrenceDate, debited: true };
    }

    // completed → missed/canceled without keep-charge: refund prior completion debit.
    if (shouldDeduct !== true && wasCompleted && alreadyDebited) {
      if (billingType === 'package') {
        creditPackageOccurrence(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId: lessonRef.id,
          occurrenceDate,
          amount: units,
        });
      } else {
        creditPostpaidOccurrence(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId: lessonRef.id,
          occurrenceDate,
          amount: units,
        });
      }
    }
    await batch.commit();
    return {
      marked: normalizedStatus,
      occurrenceDate,
      debited: shouldDeduct === true && alreadyDebited,
    };
  }

  if (normalizedStatus === 'scheduled') {
    const hadMarker = hadOccurrenceBillingMarker(existing, occurrenceDate);
    const dates = withOccurrenceStatusDates(existing, occurrenceDate, 'scheduled');
    batch.update(lessonRef, {
      ...dates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (hadMarker && shouldRefund === true) {
      const debited = await occurrenceBalanceDebited(lessonId, occurrenceDate);
      if (debited) {
        if (billingType === 'package') {
          creditPackageOccurrence(batch, {
            tutorId,
            studentRef,
            lessonRef,
            studentId,
            studentName,
            lessonId,
            occurrenceDate,
            amount: units,
          });
        } else {
          creditPostpaidOccurrence(batch, {
            tutorId,
            studentRef,
            lessonRef,
            studentId,
            studentName,
            lessonId,
            occurrenceDate,
            amount: units,
          });
        }
      }
    }
    await batch.commit();
    return { restored: true, occurrenceDate, refunded: shouldRefund === true };
  }

  return { skipped: true };
}

async function excludeRecurringOccurrence({ tutorId, lessonRef, existing, occurrenceDate }) {
  const dates = withOccurrenceStatusDates(existing, occurrenceDate, 'scheduled');
  const exdates = uniqueDates([...(existing.exdates ?? []), occurrenceDate]).filter(Boolean);
  await lessonRef.update({
    ...dates,
    exdates,
    status: 'scheduled',
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { excluded: true, occurrenceDate };
}

/**
 * @param {number} [now]
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} [docs] prefetched isRecurring lessons
 */
async function autoCompletePastRecurringOccurrences(now = Date.now(), docs = null) {
  const rangeEnd = new Date(now);
  const rangeStart = new Date(now);
  rangeStart.setDate(rangeStart.getDate() - 90);

  const list =
    docs ??
    (await db.collection('lessons').where('isRecurring', '==', true).get()).docs;
  let completed = 0;

  for (const doc of list) {
    const existing = doc.data();
    if (existing.status && existing.status !== 'scheduled') {
      continue;
    }
    if (!existing.rrule || !existing.student_id) {
      continue;
    }

    const intervals = lessonOccurrenceIntervals(existing, rangeStart, rangeEnd);
    const completedDates = uniqueDates(existing.completedDates);

    for (const interval of intervals) {
      if (interval.end > now) {
        continue;
      }
      const occurrenceDate = interval.occurrenceDate ?? dayKeyFromDate(new Date(interval.start));
      if (completedDates.includes(occurrenceDate)) {
        continue;
      }

      const studentRef = db.collection('students').doc(existing.student_id);
      const studentSnap = await studentRef.get();
      if (!studentSnap.exists) {
        continue;
      }

      await applyRecurringOccurrenceStatus({
        tutorId: existing.tutor,
        lessonRef: doc.ref,
        existing,
        occurrenceDate,
        nextStatus: 'completed',
        shouldDeduct: false,
        autoDebitEnabled: studentSnap.data().auto_debit_enabled !== false,
        studentSnap,
        studentRef,
        billImmediately: false,
      });
      completedDates.push(occurrenceDate);
      completed += 1;
    }
  }

  return { completed };
}

/**
 * @param {number} [now]
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} [docs] prefetched isRecurring lessons
 */
async function billDueRecurringOccurrences(now = Date.now(), docs = null) {
  const list =
    docs ??
    (await db.collection('lessons').where('isRecurring', '==', true).get()).docs;
  let debited = 0;

  for (const doc of list) {
    const existing = doc.data();
    if (!existing.student_id) {
      continue;
    }

    const dates = uniqueDates(existing.completedDates);
    if (dates.length === 0) {
      continue;
    }

    const studentRef = db.collection('students').doc(existing.student_id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) {
      continue;
    }

    for (const occurrenceDate of dates) {
      const result = await debitRecurringOccurrenceIfDue({
        tutorId: existing.tutor,
        lessonRef: doc.ref,
        existing,
        occurrenceDate,
        studentSnap,
        studentRef,
        now,
      });
      if (result.debited) {
        debited += 1;
      }
    }
  }

  return { debited };
}

module.exports = {
  normalizeOccurrenceDate,
  uniqueDates,
  occurrenceEndMs,
  applyRecurringOccurrenceStatus,
  debitRecurringOccurrenceIfDue,
  autoCompletePastRecurringOccurrences,
  billDueRecurringOccurrences,
  excludeRecurringOccurrence,
  occurrenceBalanceDebited,
  hadOccurrenceBillingMarker,
};
