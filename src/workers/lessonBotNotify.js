const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { normalizeLessonStatus } = require('../utils/lessonSnapshot');
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

const COMPLETE_BUFFER_MS = 30 * 60 * 1000;
const REMIND_WINDOW_MS = 90 * 1000; // ±1.5 мин вокруг отметки напоминания
const TICK_MS = 60 * 1000;
const TRIAL_EXPIRY_EVERY_MS = 60 * 60 * 1000;
let lastTrialExpiryAt = 0;

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
 */
async function processReminders(now = Date.now()) {
  const snap = await db.collection('lessons').where('status', '==', 'scheduled').get();
  let sent = 0;

  for (const doc of snap.docs) {
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
 */
async function processAutoComplete(now = Date.now()) {
  const snap = await db.collection('lessons').where('status', '==', 'scheduled').get();
  let completed = 0;

  for (const doc of snap.docs) {
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

async function tick() {
  try {
    tutorPlanCache.clear();
    const now = Date.now();
    if (now - lastTrialExpiryAt >= TRIAL_EXPIRY_EVERY_MS) {
      lastTrialExpiryAt = now;
      const expired = await expireEndedTrials(db, FieldValue);
      if (expired > 0) {
        console.log(`[lessonBotNotify] expired ${expired} admin trial(s)`);
      }
    }
    const reminded = await processReminders();
    const done = await processAutoComplete();
    // Recurring + delayed debit for completed&unprocessed (no second single auto-complete).
    const billing = await runBillingWorkerCycle({ autoCompleteSingles: false });
    if (reminded || done || billing.autoRecurring || billing.recurringBilled || billing.dueBilled) {
      console.log(
        `[lessonBotNotify] reminders=${reminded} autoComplete=${done}` +
          ` recurringDone=${billing.autoRecurring} recurringBilled=${billing.recurringBilled}` +
          ` delayedBilled=${billing.dueBilled}`,
      );
    }
  } catch (err) {
    console.error('[lessonBotNotify] tick failed:', err.message || err);
  }
}

function startLessonBotNotifyWorker() {
  if (process.env.LESSON_BOT_NOTIFY_DISABLED === '1') {
    console.log('[lessonBotNotify] disabled via LESSON_BOT_NOTIFY_DISABLED');
    return null;
  }
  console.log('[lessonBotNotify] started (every 60s, remind=per-student offset, complete=+30m after end)');
  void tick();
  return setInterval(() => void tick(), TICK_MS);
}

module.exports = {
  startLessonBotNotifyWorker,
  processReminders,
  processAutoComplete,
};
