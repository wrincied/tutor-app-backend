const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { normalizeLessonStatus, isCompletedStatus } = require('../utils/lessonSnapshot');
const { normalizeBillingType } = require('../utils/studentBilling');

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

function appendBalanceLog(batch, { tutorId, studentId, lessonId, amount, reason }) {
  const logRef = db.collection('balance_logs').doc();
  batch.set(logRef, {
    tutor: tutorId,
    studentId,
    lessonId,
    amount,
    reason,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Списание/возврат 1 урока в batch (без commit).
 */
function applyBalanceDebit(batch, { tutorId, studentRef, lessonRef, studentId, lessonId, reason }) {
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(-1),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    balance_debited: true,
    billing_processed: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLog(batch, {
    tutorId,
    studentId,
    lessonId,
    amount: -1,
    reason,
  });
}

function applyBalanceRefund(batch, { tutorId, studentRef, lessonRef, studentId, lessonId, reason }) {
  batch.update(studentRef, {
    balance_lessons: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(lessonRef, {
    balance_debited: false,
    billing_processed: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  appendBalanceLog(batch, {
    tutorId,
    studentId,
    lessonId,
    amount: 1,
    reason,
  });
}

/**
 * Биллинг при смене статуса (completed / missed / canceled).
 */
function applyLessonStatusBilling(batch, {
  tutorId,
  studentId,
  studentRef,
  lessonRef,
  lessonId,
  previousStatus,
  nextStatus,
  balanceDebited,
  billingProcessed,
  studentBillingType,
  shouldDeduct,
  autoDebitEnabled,
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

  if (willBeCompleted && !wasCompleted) {
    if (alreadyDebited || wasBillingProcessed) {
      return { skipped: true };
    }
    if (autoDebitEnabled === false) {
      return { skipped: true, autoDebitDisabled: true };
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
          lessonId,
          reason: balanceLogReason(nextStatus, true, false),
        });
        return { debited: true };
      }
      return { skipped: true, alreadyDebited: true };
    }
    if (shouldDeduct === false && alreadyDebited) {
      applyBalanceRefund(batch, {
        tutorId,
        studentRef,
        lessonRef,
        studentId,
        lessonId,
        reason: balanceLogReason(nextStatus, false, true),
      });
      return { refunded: true };
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
          lessonId,
          reason: 'lesson_uncompleted_refund',
        });
        return { refunded: true };
      }
      batch.update(studentRef, {
        unpaid_lessons_count: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(lessonRef, {
        billing_processed: false,
        billing_processed_at: FieldValue.delete(),
        completed_at: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      appendBalanceLog(batch, {
        tutorId,
        studentId,
        lessonId,
        amount: -1,
        reason: 'lesson_uncompleted_postpaid_reversal',
      });
      return { postpaidReversed: true };
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
    studentRef,
    lessonRef,
    lessonId,
    previousStatus: existing.status,
    nextStatus: normalizedStatus,
    balanceDebited: existing.balance_debited,
    billingProcessed: existing.billing_processed,
    studentBillingType: studentSnap.data().billing_type,
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
};
