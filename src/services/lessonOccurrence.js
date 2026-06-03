const { db, FieldValue } = require('../firebase');
const { normalizeLessonStatus, isCompletedStatus } = require('../utils/lessonSnapshot');
const { normalizeBillingType } = require('../utils/studentBilling');
const { appendStudentBalanceLog } = require('../utils/activityLog');
const { LESSON_BILLING_BUFFER_MS } = require('../utils/lessonBillingConstants');
const { lessonOccurrenceIntervals, dayKeyFromDate } = require('../utils/lessonRecurrence');

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
  const snap = await db.collection('balance_logs').where('lessonId', '==', lessonId).limit(100).get();
  return snap.docs.some((doc) => String(doc.data().occurrenceDate ?? '').slice(0, 10) === occurrenceDate);
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
}) {
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(-1),
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
    amount: -1,
    reason: 'lesson_completed_occurrence',
    occurrenceDate,
  });
}

function creditPackageOccurrence(batch, {
  tutorId,
  studentRef,
  lessonRef,
  studentId,
  studentName,
  lessonId,
  occurrenceDate,
}) {
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(1),
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
    amount: 1,
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
}) {
  batch.update(studentRef, {
    unpaid_lessons_count: FieldValue.increment(1),
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
    amount: 1,
    reason: 'lesson_completed_postpaid_occurrence',
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
}) {
  batch.update(studentRef, {
    unpaid_lessons_count: FieldValue.increment(-1),
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
    amount: -1,
    reason: 'lesson_occurrence_uncompleted_postpaid',
    occurrenceDate,
  });
}

/**
 * Смена статуса одного вхождения серии (completed / scheduled / missed / canceled).
 */
function occurrenceEndMs(lesson, occurrenceDate) {
  const [y, m, d] = occurrenceDate.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0);
  const dayEnd = new Date(y, m - 1, d, 23, 59, 59, 999);
  const intervals = lessonOccurrenceIntervals(lesson, dayStart, dayEnd);
  const match = intervals.find(
    (interval) => dayKeyFromDate(new Date(interval.start)) === occurrenceDate,
  );
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
    });
  }
  await batch.commit();
  return { debited: true, occurrenceDate };
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
  const completedDates = uniqueDates(existing.completedDates);
  const exdates = uniqueDates(existing.exdates);
  const wasCompleted = completedDates.includes(occurrenceDate);
  const billingType = normalizeBillingType(studentSnap?.data()?.billing_type);
  const lessonId = lessonRef.id;

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
    const nextCompleted = [...completedDates, occurrenceDate];
    const nextExdates = exdates.filter((date) => date !== occurrenceDate);
    batch.update(lessonRef, {
      completedDates: nextCompleted,
      exdates: nextExdates,
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
    const nextExdates = exdates.filter((date) => date !== occurrenceDate);
    batch.update(lessonRef, {
      completedDates,
      exdates: nextExdates,
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
      });
    }
    await batch.commit();
    return { completed: true, occurrenceDate, repaired: true };
  }

  if (!isCompletedStatus(normalizedStatus) && wasCompleted) {
    const nextCompleted = completedDates.filter((date) => date !== occurrenceDate);
    batch.update(lessonRef, {
      completedDates: nextCompleted,
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
      });
    }
    await batch.commit();
    return { uncompleted: true, occurrenceDate };
  }

  if (
    (normalizedStatus === 'missed' || normalizedStatus === 'canceled') &&
    shouldDeduct === true &&
    !wasCompleted
  ) {
    const nextExdates = uniqueDates([...exdates, occurrenceDate]);
    batch.update(lessonRef, {
      exdates: nextExdates,
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
        lessonId: lessonRef.id,
        occurrenceDate,
      });
    }
    await batch.commit();
    return { excluded: true, occurrenceDate, debited: true };
  }

  if (normalizedStatus === 'missed' || normalizedStatus === 'canceled') {
    const nextExdates = uniqueDates([...exdates, occurrenceDate]);
    batch.update(lessonRef, {
      exdates: nextExdates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    return { excluded: true, occurrenceDate };
  }

  if (normalizedStatus === 'scheduled') {
    const wasExcluded = exdates.includes(occurrenceDate);
    const nextExdates = exdates.filter((date) => date !== occurrenceDate);
    batch.update(lessonRef, {
      exdates: nextExdates,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (wasExcluded && shouldRefund === true) {
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
  const exdates = uniqueDates([...(existing.exdates ?? []), occurrenceDate]);
  const completedDates = uniqueDates(existing.completedDates).filter(
    (date) => date !== occurrenceDate,
  );
  await lessonRef.update({
    exdates,
    completedDates,
    status: 'scheduled',
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { excluded: true, occurrenceDate };
}

async function autoCompletePastRecurringOccurrences(now = Date.now()) {
  const rangeEnd = new Date(now);
  const rangeStart = new Date(now);
  rangeStart.setDate(rangeStart.getDate() - 90);

  const snap = await db.collection('lessons').where('status', '==', 'scheduled').get();
  let completed = 0;

  for (const doc of snap.docs) {
    const existing = doc.data();
    const recurring = existing.isRecurring === true || Boolean(existing.rrule);
    if (!recurring || !existing.rrule || !existing.student_id) {
      continue;
    }

    const intervals = lessonOccurrenceIntervals(existing, rangeStart, rangeEnd);
    const completedDates = uniqueDates(existing.completedDates);

    for (const interval of intervals) {
      if (interval.end > now) {
        continue;
      }
      const occurrenceDate = dayKeyFromDate(new Date(interval.start));
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

async function billDueRecurringOccurrences(now = Date.now()) {
  const snap = await db.collection('lessons').get();
  let debited = 0;

  for (const doc of snap.docs) {
    const existing = doc.data();
    const recurring = existing.isRecurring === true || Boolean(existing.rrule);
    if (!recurring || !existing.student_id) {
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
};
