const { db, FieldValue } = require('../firebase');
const { normalizeBillingType, normalizeRateUnit, packageDebitAmount } = require('./studentBilling');
const { appendStudentBalanceLog } = require('./activityLog');
const { LESSON_BILLING_BUFFER_MS } = require('./lessonBillingConstants');
const {
  autoCompletePastRecurringOccurrences,
  billDueRecurringOccurrences,
} = require('../services/lessonOccurrence');
const { notifyLowPackageBalanceIfNeeded } = require('./lowBalanceNotify');

const BUFFER_MS = LESSON_BILLING_BUFFER_MS;
const BILLING_TICK_MS = 10 * 60 * 1000;

function completedAtMs(lesson) {
  const raw = lesson.completed_at;
  if (!raw) {
    return null;
  }
  if (typeof raw.toDate === 'function') {
    return raw.toDate().getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function isLessonDueForBilling(lesson, now = Date.now()) {
  if (lesson.status !== 'completed' || lesson.billing_processed === true) {
    return false;
  }
  const completedMs = completedAtMs(lesson);
  if (completedMs === null) {
    return false;
  }
  return now - completedMs >= BUFFER_MS;
}

function filterDueLessons(lessons, now = Date.now()) {
  const cutoff = now - BUFFER_MS;
  return lessons.filter((lesson) => {
    if (lesson.status !== 'completed' || lesson.billing_processed === true) {
      return false;
    }
    const completedMs = completedAtMs(lesson);
    return completedMs !== null && completedMs <= cutoff;
  });
}

/**
 * @param {object} student
 * @param {{ billingType?: string, lessonDuration?: number|string } | string} [opts]
 */
function computeStudentBillingUpdate(student, opts = {}) {
  const billingTypeArg = typeof opts === 'string' ? opts : opts?.billingType;
  const lessonDuration = typeof opts === 'string' ? undefined : opts?.lessonDuration;
  const type = normalizeBillingType(billingTypeArg ?? student.billing_type);
  const rateUnit = normalizeRateUnit(student.rate_unit);
  const units = packageDebitAmount({ rateUnit, lessonDuration });

  if (type === 'package') {
    const currentRaw = Number(student.balance_lessons);
    const current = Number.isFinite(currentRaw) ? currentRaw : 0;
    const available = Math.max(0, current);
    const actualDebit = Math.round(Math.min(units, available) * 100) / 100;
    const next = Math.round((current - actualDebit) * 100) / 100;
    return {
      billingType: 'package',
      units,
      studentPatch: actualDebit > 0 ? { balance_lessons: next } : {},
      balanceLog: { amount: -actualDebit, reason: 'lesson_completed_delayed' },
      balanceDebited: actualDebit > 0,
      balanceUnitsDebited: actualDebit > 0 ? actualDebit : undefined,
    };
  }

  const currentUnpaid = Number(student.unpaid_lessons_count) || 0;
  return {
    billingType: 'postpaid',
    units,
    studentPatch: {
      unpaid_lessons_count: Math.round((currentUnpaid + units) * 100) / 100,
    },
    balanceLog: { amount: units, reason: 'lesson_completed_postpaid' },
    balanceDebited: false,
    balanceUnitsDebited: units,
  };
}

function appendBalanceLogTx(tx, { tutorId, studentId, studentName, lessonId, amount, reason }) {
  if (!amount) {
    return;
  }
  const logRef = db.collection('balance_logs').doc();
  tx.set(logRef, {
    tutor: tutorId,
    studentId,
    lessonId,
    amount,
    reason,
    createdAt: FieldValue.serverTimestamp(),
  });
  appendStudentBalanceLog(tx, { tutorId, studentId, studentName, lessonId, amount, reason });
}

async function processLessonInTransaction(lessonId) {
  const lessonRef = db.collection('lessons').doc(lessonId);

  return db.runTransaction(async (tx) => {
    const lessonSnap = await tx.get(lessonRef);
    if (!lessonSnap.exists) {
      return null;
    }

    const lesson = lessonSnap.data();
    if (!isLessonDueForBilling(lesson)) {
      return null;
    }

    const studentId = lesson.student_id;
    if (!studentId) {
      tx.update(lessonRef, {
        billing_processed: true,
        billing_processed_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return null;
    }

    const studentRef = db.collection('students').doc(studentId);
    const studentSnap = await tx.get(studentRef);
    if (!studentSnap.exists) {
      return null;
    }

    const student = studentSnap.data();
    const tutorId = lesson.tutor;
    const billingUpdate = computeStudentBillingUpdate(student, {
      lessonDuration: lesson.lesson_duration,
    });

    if (Object.keys(billingUpdate.studentPatch).length > 0) {
      tx.update(studentRef, {
        ...billingUpdate.studentPatch,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    appendBalanceLogTx(tx, {
      tutorId,
      studentId,
      studentName: student.name,
      lessonId,
      ...billingUpdate.balanceLog,
    });

    if (
      billingUpdate.billingType === 'package' &&
      billingUpdate.studentPatch.balance_lessons != null &&
      billingUpdate.studentPatch.balance_lessons <= 1
    ) {
      console.info(
        `[billingWorker] student ${studentId} has ${billingUpdate.studentPatch.balance_lessons} unit(s) left on package`,
      );
    }

    const lessonPatch = {
      billing_processed: true,
      billing_processed_at: FieldValue.serverTimestamp(),
      balance_debited: billingUpdate.balanceDebited,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (billingUpdate.balanceUnitsDebited != null && billingUpdate.balanceUnitsDebited > 0) {
      lessonPatch.balance_units_debited = billingUpdate.balanceUnitsDebited;
    }
    tx.update(lessonRef, lessonPatch);

    if (
      billingUpdate.billingType !== 'package' ||
      billingUpdate.studentPatch.balance_lessons == null
    ) {
      return null;
    }

    return {
      studentId,
      tutorId,
      balanceLeft: billingUpdate.studentPatch.balance_lessons,
      rateUnit: normalizeRateUnit(student.rate_unit),
      botActive: student.bot_active,
      telegramUserId: student.telegram_user_id,
      telegramChatId: student.telegram_chat_id,
      telegramSettings: student.telegram_notification_settings,
      billingTypeRaw: student.billing_type,
    };
  });
}

function lessonEndMs(lesson) {
  const start = Date.parse(String(lesson.scheduledAt));
  if (Number.isNaN(start)) {
    return null;
  }
  const duration = Number(lesson.lesson_duration) || 60;
  return start + duration * 60_000;
}

/**
 * Legacy path: mark singles completed at lesson end (no immediate debit).
 * Prefer lessonBotNotify.processAutoComplete (end + 30m → status + debit).
 * Kept for fallback when LESSON_BOT_NOTIFY_DISABLED=1.
 */
async function autoCompletePastSingleLessons(now = Date.now()) {
  const snap = await db.collection('lessons').where('status', '==', 'scheduled').get();
  let count = 0;

  for (const doc of snap.docs) {
    const lesson = doc.data();
    if (lesson.isRecurring === true || lesson.rrule) {
      continue;
    }
    const endMs = lessonEndMs(lesson);
    if (endMs === null || endMs > now) {
      continue;
    }
    await doc.ref.update({
      status: 'completed',
      completed_at: new Date(endMs),
      billing_processed: false,
      balance_debited: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    count += 1;
  }

  return { count };
}

/**
 * @param {{ autoCompleteSingles?: boolean }} [options]
 * - autoCompleteSingles=false when lessonBotNotify already completes singles at end+30m
 */
async function runBillingWorkerCycle(options = {}) {
  const autoCompleteSingles = options.autoCompleteSingles !== false;
  const now = Date.now();

  const autoSingle = autoCompleteSingles
    ? await autoCompletePastSingleLessons(now)
    : { count: 0 };
  const autoRecurring = await autoCompletePastRecurringOccurrences(now);
  const recurringBilled = await billDueRecurringOccurrences(now);

  const snap = await db
    .collection('lessons')
    .where('status', '==', 'completed')
    .where('billing_processed', '==', false)
    .get();

  const dueLessons = [];
  snap.forEach((doc) => {
    const lesson = doc.data();
    if (isLessonDueForBilling(lesson, now)) {
      dueLessons.push(doc.id);
    }
  });

  for (const lessonId of dueLessons) {
    try {
      const billed = await processLessonInTransaction(lessonId);
      if (billed?.studentId != null && billed.balanceLeft != null) {
        await notifyLowPackageBalanceIfNeeded(billed.studentId, {
          tutorId: billed.tutorId,
          student: {
            _id: billed.studentId,
            balance_lessons: billed.balanceLeft,
            billing_type: billed.billingTypeRaw,
            rate_unit: billed.rateUnit,
            bot_active: billed.botActive,
            telegram_user_id: billed.telegramUserId,
            telegram_chat_id: billed.telegramChatId,
            telegram_notification_settings: billed.telegramSettings,
          },
        });
      }
    } catch (error) {
      console.error(`[billingWorker] failed lesson ${lessonId}:`, error.message);
    }
  }

  const parts = [];
  if (autoSingle.count > 0) {
    parts.push(`auto-completed ${autoSingle.count} single`);
  }
  if (autoRecurring.completed > 0) {
    parts.push(`auto-completed ${autoRecurring.completed} recurring occurrence(s)`);
  }
  if (recurringBilled.debited > 0) {
    parts.push(`billed ${recurringBilled.debited} recurring occurrence(s)`);
  }
  if (dueLessons.length > 0) {
    parts.push(`billed ${dueLessons.length} single lesson(s)`);
  }
  if (parts.length > 0) {
    console.info(`[billingWorker] ${parts.join(', ')}`);
  }

  return {
    autoSingle: autoSingle.count,
    autoRecurring: autoRecurring.completed,
    recurringBilled: recurringBilled.debited,
    dueBilled: dueLessons.length,
  };
}

/**
 * Fallback scheduler when Telegram/lesson notify worker is disabled.
 * Normal path: lessonBotNotify tick calls runBillingWorkerCycle({ autoCompleteSingles: false }).
 */
function startBillingWorker() {
  if (process.env.BILLING_WORKER_DISABLED === '1') {
    console.info('[billingWorker] disabled via BILLING_WORKER_DISABLED');
    return null;
  }
  if (process.env.LESSON_BOT_NOTIFY_DISABLED !== '1') {
    console.info(
      '[billingWorker] scheduler idle — cycle runs from lessonBotNotify tick (singles at end+30m there)',
    );
    return null;
  }
  console.info('[billingWorker] started fallback (every 10m, includes single auto-complete at end)');
  void runBillingWorkerCycle({ autoCompleteSingles: true }).catch((err) => {
    console.error('[billingWorker] initial cycle failed:', err.message || err);
  });
  return setInterval(() => {
    void runBillingWorkerCycle({ autoCompleteSingles: true }).catch((err) => {
      console.error('[billingWorker] cycle failed:', err.message || err);
    });
  }, BILLING_TICK_MS);
}

module.exports = {
  startBillingWorker,
  runBillingWorkerCycle,
  autoCompletePastSingleLessons,
  BUFFER_MS,
  BILLING_TICK_MS,
  completedAtMs,
  isLessonDueForBilling,
  filterDueLessons,
  computeStudentBillingUpdate,
};
