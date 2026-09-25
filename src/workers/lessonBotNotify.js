const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { applyLessonStatusBilling } = require('../services/lessonBilling');
const {
  notifyLessonStart,
  notifyHomework,
} = require('../utils/telegramBot');
const {
  normalizeTelegramSettings,
} = require('../utils/telegramNotificationSettings');
const { notifyLowPackageBalanceIfNeeded } = require('../utils/lowBalanceNotify');
const { resolveTutorName } = require('../utils/tutorName');
const {
  formatLessonTimeLabel,
  resolveTutorTimezone,
} = require('../utils/lessonNotifyTime');
const { hasTelegramAccess, subscriptionLabel } = require('../utils/userProfile');
const { expireEndedTrials } = require('../utils/trialExpiry');
const { runBillingWorkerCycle } = require('../utils/billingWorker');
const {
  COMPLETE_BUFFER_MS,
  REMIND_WINDOW_MS,
  DAILY_LONG_REMINDER_EVERY_MS,
  fetchCandidateScheduled,
  fetchLongOffsetReminderCandidates,
} = require('../utils/scheduledLessonCandidates');

const TICK_MS = 60 * 1000;
const TRIAL_EXPIRY_EVERY_MS = 60 * 60 * 1000;
/** Recurring + delayed billing — soft timing (+30m buffers); keep reminders on TICK_MS. */
const DEFAULT_HEAVY_TICK_MS = 10 * 60 * 1000;

function resolveHeavyTickMs() {
  const raw = Number(process.env.LESSON_WORKER_HEAVY_MS);
  if (Number.isFinite(raw) && raw >= 60_000) {
    return Math.floor(raw);
  }
  return DEFAULT_HEAVY_TICK_MS;
}

const HEAVY_TICK_MS = resolveHeavyTickMs();

/** Persisted cadence for scale-to-zero / Scheduler wakes (not in-process RAM). */
const WORKER_STATE_REF = () => db.collection('system').doc('lesson_worker');

async function loadWorkerState() {
  const snap = await WORKER_STATE_REF().get();
  const data = snap.exists ? snap.data() || {} : {};
  return {
    lastHeavyAt: Number(data.lastHeavyAt) || 0,
    lastTrialExpiryAt: Number(data.lastTrialExpiryAt) || 0,
    lastLongOffsetReminderAt: Number(data.lastLongOffsetReminderAt) || 0,
  };
}

async function saveWorkerState(partial) {
  await WORKER_STATE_REF().set(
    {
      ...partial,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** tutorId → subscription status (refreshed per tick). */
const tutorPlanCache = new Map();

async function tutorHasTelegram(tutorId) {
  const id = String(tutorId || '');
  if (!id) {
    return false;
  }
  if (tutorPlanCache.has(id)) {
    return tutorPlanCache.get(id);
  }
  const snap = await db.collection('users').doc(id).get();
  const allowed = hasTelegramAccess(
    subscriptionLabel(snap.exists ? snap.data()?.subscription_status : 'free'),
  );
  tutorPlanCache.set(id, allowed);
  return allowed;
}

function lessonEndMs(lesson) {
  const start = Date.parse(lesson.scheduledAt);
  if (Number.isNaN(start)) {
    return null;
  }
  const duration = Number(lesson.lesson_duration) || 60;
  return start + duration * 60 * 1000;
}

async function loadStudent(studentId) {
  if (!studentId) {
    return null;
  }
  const snap = await db.collection('students').doc(String(studentId)).get();
  if (!snap.exists) {
    return null;
  }
  return serializeDoc(snap);
}

function canNotifyStudent(student) {
  return Boolean(
    student?.bot_active && (student?.telegram_user_id || student?.telegram_chat_id),
  );
}

async function canNotifyTutorStudent(tutorId, student) {
  if (!canNotifyStudent(student)) {
    return false;
  }
  return tutorHasTelegram(tutorId);
}

/**
 * Напоминание за N минут до старта (N из telegram_notification_settings ученика;
 * подпись времени — в timezone репетитора).
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs prefetched candidates
 */
async function processReminders(docs, now = Date.now()) {
  let sent = 0;

  for (const doc of docs) {
    const lesson = { _id: doc.id, ...doc.data() };
    if (lesson.reminder_sent === true) {
      continue;
    }
    const start = Date.parse(lesson.scheduledAt);
    if (Number.isNaN(start)) {
      continue;
    }

    const student = await loadStudent(lesson.student_id);
    const settings = normalizeTelegramSettings(student?.telegram_notification_settings);
    if (!settings.lesson_reminder_enabled) {
      await doc.ref.update({
        reminder_sent: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }

    const remindMinutes = settings.lesson_reminder_offset_minutes;
    const remindAt = start - remindMinutes * 60 * 1000;
    if (Math.abs(now - remindAt) > REMIND_WINDOW_MS) {
      continue;
    }

    if (!(await canNotifyTutorStudent(lesson.tutor, student))) {
      await doc.ref.update({
        reminder_sent: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }

    const tz = await resolveTutorTimezone(lesson.tutor);
    const tutorName = await resolveTutorName(lesson.tutor);
    const meetingLink = student.meeting_link || lesson.meeting_link || null;
    const result = await notifyLessonStart({
      studentId: student._id,
      minutesBefore: remindMinutes,
      timeLabel: formatLessonTimeLabel(lesson.scheduledAt, tz),
      meetingLink,
      tutorName,
      subject: student.subject || null,
      scheduledAt: lesson.scheduledAt || null,
      durationMinutes: Number(lesson.lesson_duration) || 60,
      timezone: tz,
    });

    await doc.ref.update({
      reminder_sent: true,
      reminder_sent_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (result.ok) {
      sent += 1;
    }
  }

  return sent;
}

/**
 * Через 30 минут после окончания одиночного урока → completed + списание + TG.
 * Recurring обрабатывает billingWorker (completedDates).
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs prefetched candidates
 */
async function processAutoComplete(docs, now = Date.now()) {
  let completed = 0;

  for (const doc of docs) {
    const lesson = { _id: doc.id, ...doc.data() };
    if (lesson.isRecurring === true || lesson.rrule) {
      continue;
    }
    const endMs = lessonEndMs(lesson);
    if (endMs == null) {
      continue;
    }
    if (now < endMs + COMPLETE_BUFFER_MS) {
      continue;
    }

    const student = await loadStudent(lesson.student_id);
    const tutorId = lesson.tutor;
    const lessonRef = doc.ref;

    if (!tutorId || !student) {
      await lessonRef.update({
        status: 'completed',
        completed_at: FieldValue.serverTimestamp(),
        billing_processed: true,
        balance_debited: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      completed += 1;
      continue;
    }

    if (student.auto_debit_enabled === false) {
      await lessonRef.update({
        status: 'completed',
        completed_at: FieldValue.serverTimestamp(),
        billing_processed: true,
        balance_debited: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      completed += 1;
    } else {
      const batch = db.batch();
      const studentRef = db.collection('students').doc(student._id);
      batch.update(lessonRef, {
        status: 'completed',
        updatedAt: FieldValue.serverTimestamp(),
      });
      applyLessonStatusBilling(batch, {
        tutorId,
        studentId: student._id,
        studentName: student.name,
        studentRef,
        lessonRef,
        lessonId: lesson._id,
        previousStatus: 'scheduled',
        nextStatus: 'completed',
        balanceDebited: Boolean(lesson.balance_debited),
        billingProcessed: Boolean(lesson.billing_processed),
        studentBillingType: student.billing_type,
        studentRateUnit: student.rate_unit,
        lessonDuration: lesson.lesson_duration,
        balanceUnitsDebited: lesson.balance_units_debited,
        autoDebitEnabled: true,
        manualCompletion: true,
        studentBalance: student.balance_lessons,
      });
      await batch.commit();
      completed += 1;
    }

    if (lesson.post_lesson_notified === true) {
      continue;
    }

    if (!(await canNotifyTutorStudent(tutorId, student))) {
      await lessonRef.update({
        post_lesson_notified: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }

    const homeworkText = (lesson.notes && String(lesson.notes).trim()) || '';
    const tutorName = await resolveTutorName(tutorId);
    await notifyHomework({ studentId: student._id, text: homeworkText, tutorName });

    const fresh = await loadStudent(student._id);
    await notifyLowPackageBalanceIfNeeded(student._id, {
      tutorId,
      student: fresh || student,
    });

    await lessonRef.update({
      post_lesson_notified: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return completed;
}

/**
 * One worker cycle (reminders / auto-complete / optional heavy billing).
 * Cadence timestamps live in Firestore `system/lesson_worker` so Scheduler + min=0 works.
 */
async function runLessonBotNotifyTick() {
  tutorPlanCache.clear();
  const now = Date.now();
  const state = await loadWorkerState();

  const runHeavy = now - state.lastHeavyAt >= HEAVY_TICK_MS;
  const runTrialExpiry = now - state.lastTrialExpiryAt >= TRIAL_EXPIRY_EVERY_MS;
  const runLongOffset = now - state.lastLongOffsetReminderAt >= DAILY_LONG_REMINDER_EVERY_MS;

  const nextState = { ...state };
  if (runHeavy) {
    nextState.lastHeavyAt = now;
  }

  let expiredTrials = 0;
  if (runTrialExpiry) {
    nextState.lastTrialExpiryAt = now;
    expiredTrials = await expireEndedTrials(db, FieldValue);
    if (expiredTrials > 0) {
      console.log(`[lessonBotNotify] expired ${expiredTrials} admin trial(s)`);
    }
  }

  const candidates = await fetchCandidateScheduled(now);
  let reminderDocs = candidates.docs;

  let longOffset = null;
  if (runLongOffset) {
    nextState.lastLongOffsetReminderAt = now;
    longOffset = await fetchLongOffsetReminderCandidates(now);
    if (longOffset.size > 0) {
      const seen = new Set(reminderDocs.map((d) => d.id));
      reminderDocs = reminderDocs.concat(longOffset.docs.filter((d) => !seen.has(d.id)));
    }
  }

  console.log(
    `[lessonBotNotify] tick=${runHeavy ? 'heavy' : 'light'}` +
      ` candidates=${candidates.size} fetchMs=${candidates.fetchMs}` +
      (longOffset
        ? ` longOffset=${longOffset.size} longFetchMs=${longOffset.fetchMs}`
        : ''),
  );

  const reminded = await processReminders(reminderDocs, now);
  const done = await processAutoComplete(candidates.docs, now);

  let billing = {
    autoRecurring: 0,
    recurringBilled: 0,
    dueBilled: 0,
  };
  if (runHeavy) {
    billing = await runBillingWorkerCycle({ autoCompleteSingles: false });
  }

  await saveWorkerState(nextState);

  if (reminded || done || billing.autoRecurring || billing.recurringBilled || billing.dueBilled) {
    console.log(
      `[lessonBotNotify] reminders=${reminded} autoComplete=${done}` +
        ` recurringDone=${billing.autoRecurring} recurringBilled=${billing.recurringBilled}` +
        ` delayedBilled=${billing.dueBilled}`,
    );
  }

  return {
    mode: runHeavy ? 'heavy' : 'light',
    candidates: candidates.size,
    reminded,
    autoComplete: done,
    expiredTrials,
    ...billing,
  };
}

/** @deprecated use runLessonBotNotifyTick — kept for older call sites / logs */
async function tick() {
  return runLessonBotNotifyTick();
}

function schedulerModeEnabled() {
  const mode = String(process.env.LESSON_BOT_NOTIFY_MODE || '')
    .trim()
    .toLowerCase();
  return mode === 'scheduler' || mode === 'http';
}

function startLessonBotNotifyWorker() {
  if (process.env.LESSON_BOT_NOTIFY_DISABLED === '1') {
    console.log('[lessonBotNotify] disabled via LESSON_BOT_NOTIFY_DISABLED');
    return null;
  }
  if (schedulerModeEnabled()) {
    console.log(
      '[lessonBotNotify] scheduler mode — in-process interval off;' +
        ' wake via POST /api/internal/lesson-worker/tick',
    );
    return null;
  }
  console.log(
    `[lessonBotNotify] started (light every ${TICK_MS / 1000}s: reminders+singles;` +
      ` heavy every ${HEAVY_TICK_MS / 1000}s: recurring+delayed billing)`,
  );
  const safeTick = () =>
    void runLessonBotNotifyTick().catch((err) => {
      console.error('[lessonBotNotify] tick failed:', err.message || err);
    });
  safeTick();
  return setInterval(safeTick, TICK_MS);
}

module.exports = {
  startLessonBotNotifyWorker,
  runLessonBotNotifyTick,
  processReminders,
  processAutoComplete,
};
