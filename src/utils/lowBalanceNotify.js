const { db } = require('../firebase');
const { serializeDoc } = require('./serialize');
const { notifyBalance } = require('./telegramBot');
const { shouldNotifyLowPackageBalance } = require('./telegramNotificationSettings');
const { hasTelegramAccess, subscriptionLabel } = require('./userProfile');
const { resolveTutorName } = require('./tutorName');

async function tutorAllowsTelegram(tutorId) {
  const id = String(tutorId || '');
  if (!id) {
    return false;
  }
  const snap = await db.collection('users').doc(id).get();
  return hasTelegramAccess(
    subscriptionLabel(snap.exists ? snap.data()?.subscription_status : 'free'),
  );
}

function studentLinkedForBot(student) {
  return Boolean(
    student?.bot_active && (student?.telegram_user_id || student?.telegram_chat_id),
  );
}

/**
 * After a package debit: send Telegram only if low_balance_enabled and balance ≤ threshold.
 * Safe to call from workers (no-op when skipped).
 */
async function notifyLowPackageBalanceIfNeeded(studentId, { tutorId, student: studentHint } = {}) {
  let student = studentHint;
  if (!student) {
    const snap = await db.collection('students').doc(String(studentId)).get();
    if (!snap.exists) {
      return { ok: false, skipped: true, reason: 'student_missing' };
    }
    student = serializeDoc(snap);
  }

  const balance = Number(student.balance_lessons);
  const lessonsLeft = Number.isFinite(balance) ? balance : 0;
  if (!shouldNotifyLowPackageBalance(student, lessonsLeft)) {
    return { ok: false, skipped: true, reason: 'threshold_or_disabled' };
  }
  if (!studentLinkedForBot(student)) {
    return { ok: false, skipped: true, reason: 'not_linked' };
  }

  const tid = tutorId || student.tutor;
  if (!(await tutorAllowsTelegram(tid))) {
    return { ok: false, skipped: true, reason: 'plan' };
  }

  const tutorName = await resolveTutorName(tid);
  return notifyBalance({
    studentId: student._id || studentId,
    lessonsLeft,
    rateUnit: student.rate_unit,
    tutorName,
    reason: 'low_balance',
  });
}

module.exports = {
  notifyLowPackageBalanceIfNeeded,
  shouldNotifyLowPackageBalance,
};
