const cron = require('node-cron');
const { db, FieldValue } = require('../firebase');
const { normalizeBillingType } = require('./studentBilling');
const { appendStudentBalanceLog } = require('./activityLog');
const { LESSON_BILLING_BUFFER_MS } = require('./lessonBillingConstants');
const {
  autoCompletePastRecurringOccurrences,
  billDueRecurringOccurrences,
} = require('../services/lessonOccurrence');

const BUFFER_MS = LESSON_BILLING_BUFFER_MS;
const CRON_SCHEDULE = '*/10 * * * *';

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

function computeStudentBillingUpdate(student, billingType) {
  const type = normalizeBillingType(billingType ?? student.billing_type);

  if (type === 'package') {
    const currentBalance = Number(student.balance_lessons) || 0;
    return {
      billingType: 'package',
      studentPatch: { balance_lessons: currentBalance - 1 },
      balanceLog: { amount: -1, reason: 'lesson_completed_delayed' },
      balanceDebited: true,
    };
  }

  const currentUnpaid = Number(student.unpaid_lessons_count) || 0;
  return {
    billingType: 'postpaid',
    studentPatch: { unpaid_lessons_count: currentUnpaid + 1 },
    balanceLog: { amount: 1, reason: 'lesson_completed_postpaid' },
    balanceDebited: false,
  };
}

function appendBalanceLogTx(tx, { tutorId, studentId, studentName, lessonId, amount, reason }) {
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

  await db.runTransaction(async (tx) => {
    const lessonSnap = await tx.get(lessonRef);
    if (!lessonSnap.exists) {
      return;
    }

    const lesson = lessonSnap.data();
    if (!isLessonDueForBilling(lesson)) {
      return;
    }

    const studentId = lesson.student_id;
    if (!studentId) {
      tx.update(lessonRef, {
        billing_processed: true,
        billing_processed_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const studentRef = db.collection('students').doc(studentId);
    const studentSnap = await tx.get(studentRef);
    if (!studentSnap.exists) {
      return;
    }

    const student = studentSnap.data();
    const tutorId = lesson.tutor;
    const billingUpdate = computeStudentBillingUpdate(student);

    tx.update(studentRef, {
      ...billingUpdate.studentPatch,
      updatedAt: FieldValue.serverTimestamp(),
    });
    appendBalanceLogTx(tx, {
      tutorId,
      studentId,
      studentName: student.name,
      lessonId,
      ...billingUpdate.balanceLog,
    });

    if (
      billingUpdate.billingType === 'package' &&
      billingUpdate.studentPatch.balance_lessons <= 1
    ) {
      console.info(
        `[billingWorker] student ${studentId} has ${billingUpdate.studentPatch.balance_lessons} lesson(s) left on package`,
      );
    }

    tx.update(lessonRef, {
      billing_processed: true,
      billing_processed_at: FieldValue.serverTimestamp(),
      balance_debited: billingUpdate.balanceDebited,
      updatedAt: FieldValue.serverTimestamp(),
    });
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

/** Авто-завершение одиночных уроков после окончания времени (без немедленного списания). */
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

async function runBillingWorkerCycle() {
  const now = Date.now();

  const autoSingle = await autoCompletePastSingleLessons(now);
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
      await processLessonInTransaction(lessonId);
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
}

function startBillingWorker() {
  if (process.env.BILLING_WORKER_ENABLED === 'false') {
    return;
  }
  cron.schedule(CRON_SCHEDULE, () => {
    runBillingWorkerCycle().catch((error) => {
      console.error('[billingWorker] cycle error:', error);
    });
  });
  console.info('[billingWorker] scheduled every 10 minutes (30 min completion buffer)');
}

module.exports = {
  startBillingWorker,
  runBillingWorkerCycle,
  autoCompletePastSingleLessons,
  BUFFER_MS,
  completedAtMs,
  isLessonDueForBilling,
  filterDueLessons,
  computeStudentBillingUpdate,
};
