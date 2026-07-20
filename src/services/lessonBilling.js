const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { normalizeLessonStatus, isCompletedStatus } = require('../utils/lessonSnapshot');
const {
  normalizeBillingType,
  normalizeRateUnit,
  packageDebitAmount,
} = require('../utils/studentBilling');
const { appendStudentBalanceLog } = require('../utils/activityLog');

function isMissedOrCanceledStatus(status) {
  const s = normalizeLessonStatus(status);
  return s === 'missed' || s === 'canceled';
}

function balanceLogReason(nextStatus, shouldDeduct, wasDebited) {
  const status = normalizeLessonStatus(nextStatus);
  if (shouldDeduct && !wasDebited) {
    return status === 'missed' ? 'lesson_missed_deduct' : 'lesson_canceled_deduct';
  }
  if (!shouldDeduct && wasDebited) {
    return 'lesson_balance_refund';
  }
  return 'lesson_status_change';
}

function appendBalanceLog(batch, { tutorId, studentId, studentName, lessonId, amount, reason }) {
  const logRef = db.collection('balance_logs').doc();
  batch.set(logRef, {
    tutor: tutorId,
    studentId,
    lessonId,
    amount,
    reason,
    createdAt: FieldValue.serverTimestamp(),
  });
  appendStudentBalanceLog(batch, { tutorId, studentId, studentName, lessonId, amount, reason });
}

function resolveDebitAmount({ rateUnit, lessonDuration, amount }) {
  if (amount != null && Number.isFinite(Number(amount)) && Number(amount) > 0) {
    return Math.round(Number(amount) * 100) / 100;
  }
  return packageDebitAmount({ rateUnit, lessonDuration });
}

/**
 * Списание единиц абонемента (занятия или часы) в batch.
 */
function applyBalanceDebit(
  batch,
  {
    tutorId,
    studentRef,
    lessonRef,
    studentId,
    studentName,
    lessonId,
    reason,
    amount = 1,
  },
) {
  const units = Math.round(Number(amount) * 100) / 100 || 1;
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(-units),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    balance_debited: true,
    billing_processed: true,
    balance_units_debited: units,
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLog(batch, {
    tutorId,
    studentId,
    studentName,
    lessonId,
    amount: -units,
    reason,
  });
}

function applyBalanceRefund(
  batch,
  {
    tutorId,
    studentRef,
    lessonRef,
    studentId,
    studentName,
    lessonId,
    reason,
    amount = 1,
  },
) {
  const units = Math.round(Number(amount) * 100) / 100 || 1;
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(units),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    balance_debited: false,
    billing_processed: false,
    balance_units_debited: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLog(batch, {
    tutorId,
    studentId,
    studentName,
    lessonId,
    amount: units,
    reason,
  });
}

/**
 * Биллинг при смене статуса (completed / missed / canceled).
 */
function applyLessonStatusBilling(batch, {
  tutorId,
  studentId,
  studentName,
  studentRef,
  lessonRef,
  lessonId,
  previousStatus,
  nextStatus,
  balanceDebited,
  billingProcessed,
  studentBillingType,
  studentRateUnit,
  lessonDuration,
  balanceUnitsDebited,
  shouldDeduct,
  shouldRefund,
  autoDebitEnabled,
  manualCompletion = false,
}) {
  if (!studentId || !studentRef || !lessonRef) {
    return {};
  }

  const wasCompleted = isCompletedStatus(previousStatus);
  const willBeCompleted = isCompletedStatus(nextStatus);
  const wasMissedCanceled = isMissedOrCanceledStatus(previousStatus);
  const willBeMissedCanceled = isMissedOrCanceledStatus(nextStatus);
  const alreadyDebited = Boolean(balanceDebited);
  const wasBillingProcessed = Boolean(billingProcessed);
  const billingType = normalizeBillingType(studentBillingType);
  const rateUnit = normalizeRateUnit(studentRateUnit);
  const debitAmount = packageDebitAmount({ rateUnit, lessonDuration });
  const refundAmount =
    balanceUnitsDebited != null && Number(balanceUnitsDebited) > 0
      ? Math.round(Number(balanceUnitsDebited) * 100) / 100
      : debitAmount;

  if (willBeCompleted && !wasCompleted) {
    if (alreadyDebited || wasBillingProcessed) {
      return { skipped: true };
    }
    if (autoDebitEnabled === false) {
      return { skipped: true, autoDebitDisabled: true };
    }
    if (manualCompletion === true) {
      batch.update(lessonRef, {
        completed_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (billingType === 'package') {
        applyBalanceDebit(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId,
          reason: 'lesson_completed',
          amount: debitAmount,
        });
        return { debited: true, amount: debitAmount };
      }
      batch.update(studentRef, {
        unpaid_lessons_count: FieldValue.increment(debitAmount),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(lessonRef, {
        billing_processed: true,
        balance_debited: false,
        balance_units_debited: debitAmount,
      });
      appendBalanceLog(batch, {
        tutorId,
        studentId,
        studentName,
        lessonId,
        amount: debitAmount,
        reason: 'lesson_completed_postpaid',
      });
      return { debited: true, amount: debitAmount };
    }
    batch.update(lessonRef, {
      completed_at: FieldValue.serverTimestamp(),
      billing_processed: false,
      balance_debited: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { billingScheduled: true };
  }

  if (willBeMissedCanceled && !wasMissedCanceled) {
    if (shouldDeduct === true) {
      if (!alreadyDebited) {
        applyBalanceDebit(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId,
          reason: balanceLogReason(nextStatus, true, false),
          amount: debitAmount,
        });
        return { debited: true, amount: debitAmount };
      }
      return { skipped: true, alreadyDebited: true };
    }
    if (shouldDeduct === false && alreadyDebited) {
      applyBalanceRefund(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        studentName,
        lessonId,
        reason: balanceLogReason(nextStatus, false, true),
        amount: refundAmount,
      });
      return { refunded: true, amount: refundAmount };
    }
    return { skipped: true };
  }

  const shouldRefundBalance = shouldRefund === true;

  // Явный возврат без смены статуса (missed/canceled → missed/canceled).
  if (
    willBeMissedCanceled &&
    wasMissedCanceled &&
    shouldRefundBalance &&
    alreadyDebited &&
    normalizeLessonStatus(nextStatus) === normalizeLessonStatus(previousStatus)
  ) {
    applyBalanceRefund(batch, {
      tutorId,
      studentRef,
      lessonRef,
      studentId,
      studentName,
      lessonId,
      reason: 'lesson_balance_refund',
      amount: refundAmount,
    });
    return { refunded: true, amount: refundAmount };
  }

  // Восстановление урока (missed/canceled → scheduled и т.п.).
  if (wasMissedCanceled && !willBeMissedCanceled && !willBeCompleted) {
    if (shouldRefundBalance && alreadyDebited) {
      applyBalanceRefund(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        studentName,
        lessonId,
        reason: 'lesson_restored_refund',
        amount: refundAmount,
      });
      return { refunded: true, amount: refundAmount };
    }
    return { skipped: true };
  }

  if (wasCompleted && !willBeCompleted && !willBeMissedCanceled) {
    if (wasBillingProcessed) {
      if (alreadyDebited || billingType === 'package') {
        applyBalanceRefund(batch, {
          tutorId,
          studentRef,
          lessonRef,
          studentId,
          studentName,
          lessonId,
          reason: 'lesson_uncompleted_refund',
          amount: refundAmount,
        });
        return { refunded: true, amount: refundAmount };
      }
      batch.update(studentRef, {
        unpaid_lessons_count: FieldValue.increment(-refundAmount),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(lessonRef, {
        billing_processed: false,
        billing_processed_at: FieldValue.delete(),
        completed_at: FieldValue.delete(),
        balance_units_debited: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      appendBalanceLog(batch, {
        tutorId,
        studentId,
        studentName,
        lessonId,
        amount: -refundAmount,
        reason: 'lesson_uncompleted_postpaid_reversal',
      });
      return { postpaidReversed: true, amount: refundAmount };
    }
    batch.update(lessonRef, {
      completed_at: FieldValue.delete(),
      billing_processed: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { billingCanceled: true };
  }

  return {};
}

/**
 * Атомарно: статус missed/canceled + опциональное списание с balance_logs.
 * Для офлайн/повторной отправки с клиента.
 */
async function cancelLessonWithBilling({
  tutorId,
  lessonId,
  studentId,
  nextStatus,
  shouldDeduct,
  lessonPatch = {},
}) {
  const normalizedStatus = normalizeLessonStatus(nextStatus);
  if (!isMissedOrCanceledStatus(normalizedStatus)) {
    throw Object.assign(new Error('Status must be missed or canceled'), { statusCode: 400 });
  }

  const lessonRef = db.collection('lessons').doc(lessonId);
  const lessonSnap = await lessonRef.get();
  if (!lessonSnap.exists || lessonSnap.data().tutor !== tutorId) {
    throw Object.assign(new Error('Lesson not found'), { statusCode: 404 });
  }

  const existing = lessonSnap.data();
  const resolvedStudentId = studentId || existing.student_id;
  if (!resolvedStudentId) {
    throw Object.assign(new Error('student_id is required'), { statusCode: 400 });
  }

  const studentRef = db.collection('students').doc(resolvedStudentId);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
    throw Object.assign(new Error('Student not found'), { statusCode: 404 });
  }

  const batch = db.batch();
  batch.update(lessonRef, {
    ...lessonPatch,
    status: normalizedStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  applyLessonStatusBilling(batch, {
    tutorId,
    studentId: resolvedStudentId,
    studentName: studentSnap.data().name,
    studentRef,
    lessonRef,
    lessonId,
    previousStatus: existing.status,
    nextStatus: normalizedStatus,
    balanceDebited: existing.balance_debited,
    billingProcessed: existing.billing_processed,
    studentBillingType: studentSnap.data().billing_type,
    studentRateUnit: studentSnap.data().rate_unit,
    lessonDuration: existing.lesson_duration,
    balanceUnitsDebited: existing.balance_units_debited,
    shouldDeduct: Boolean(shouldDeduct),
    autoDebitEnabled: studentSnap.data().auto_debit_enabled !== false,
  });

  await batch.commit();

  const [updatedLesson, updatedStudent] = await Promise.all([
    lessonRef.get(),
    studentRef.get(),
  ]);

  return {
    lesson: serializeDoc(updatedLesson),
    student: serializeDoc(updatedStudent),
  };
}

function applyLessonBalanceOnCreate(batch, {
  lessonRef,
  status,
  autoDebitEnabled,
}) {
  if (autoDebitEnabled === false || !isCompletedStatus(status)) {
    return {};
  }
  batch.update(lessonRef, {
    completed_at: FieldValue.serverTimestamp(),
    billing_processed: false,
    balance_debited: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { billingScheduled: true };
}

module.exports = {
  isMissedOrCanceledStatus,
  isCompletedStatus,
  applyLessonStatusBilling,
  applyLessonBalanceOnCreate,
  applyBalanceDebit,
  applyBalanceRefund,
  appendBalanceLog,
  cancelLessonWithBilling,
  resolveDebitAmount,
};
