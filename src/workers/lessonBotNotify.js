const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { normalizeLessonStatus } = require('../utils/lessonSnapshot');
const { applyLessonStatusBilling } = require('../services/lessonBilling');
const {
  notifyLessonStart,
  notifyHomework,
  notifyBalance,
} = require('../utils/telegramBot');
const { resolveTutorName } = require('../utils/tutorName');
const {
  formatLessonTimeLabel,
  resolveTutorTimezone,
} = require('../utils/lessonNotifyTime');

const REMIND_MINUTES = 30;
const COMPLETE_BUFFER_MS = 30 * 60 * 1000;
const REMIND_WINDOW_MS = 90 * 1000; // ±1.5 мин вокруг отметки «за 30 мин»
const TICK_MS = 60 * 1000;

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
  return Boolean(student?.bot_active && student?.telegram_user_id);
}

/**
 * Напоминание за 30 минут до старта (по абсолютному времени урока;
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
    const remindAt = start - REMIND_MINUTES * 60 * 1000;
    if (Math.abs(now - remindAt) > REMIND_WINDOW_MS) {
      continue;
    }

    const student = await loadStudent(lesson.student_id);
    if (!canNotifyStudent(student)) {
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
      minutesBefore: REMIND_MINUTES,
      timeLabel: formatLessonTimeLabel(lesson.scheduledAt, tz),
      meetingLink,
      tutorName,
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
 * Через 30 минут после окончания урока → completed + домашка + баланс.
 */
async function processAutoComplete(now = Date.now()) {
  const snap = await db.collection('lessons').where('status', '==', 'scheduled').get();
  let completed = 0;

  for (const doc of snap.docs) {
    const lesson = { _id: doc.id, ...doc.data() };
    if (lesson.post_lesson_notified === true) {
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
    if (!tutorId || !student) {
      await doc.ref.update({
        status: 'completed',
        completed_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      completed += 1;
      continue;
    }

    const batch = db.batch();
    const lessonRef = doc.ref;
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
      autoDebitEnabled: student.auto_debit_enabled !== false,
      manualCompletion: true,
    });
    await batch.commit();
    completed += 1;

    if (!canNotifyStudent(student)) {
      await lessonRef.update({
        post_lesson_notified: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }

    const homeworkText =
      (lesson.notes && String(lesson.notes).trim()) ||
      'Домашка: уточни у репетитора, если задание ещё не прислали.';
    const tutorName = await resolveTutorName(tutorId);
    await notifyHomework({ studentId: student._id, text: homeworkText, tutorName });

    const fresh = await loadStudent(student._id);
    const balance = Number(fresh?.balance_lessons) || 0;
    if ((fresh?.billing_type || 'package') !== 'postpaid') {
      await notifyBalance({
        studentId: student._id,
        lessonsLeft: balance,
        rateUnit: fresh?.rate_unit,
        tutorName,
      });
    }

    await lessonRef.update({
      post_lesson_notified: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return completed;
}

async function tick() {
  try {
    const reminded = await processReminders();
    const done = await processAutoComplete();
    if (reminded || done) {
      console.log(`[lessonBotNotify] reminders=${reminded} autoComplete=${done}`);
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
  console.log('[lessonBotNotify] started (every 60s, remind=30m, complete=+30m after end)');
  void tick();
  return setInterval(() => void tick(), TICK_MS);
}

module.exports = {
  startLessonBotNotifyWorker,
  processReminders,
  processAutoComplete,
  REMIND_MINUTES,
};
