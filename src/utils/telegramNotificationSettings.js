const BUILTIN = new Set([15, 30, 60, 1440]);
const LEGACY = new Set([15, 30, 60, 120, 1440]);
const { FieldValue } = require('../firebase');
const TARGETS = new Set(['student', 'parent', 'tutor']);
const DISABLED_TARGETS = new Set(['parent', 'tutor']);
const OFFSET_MIN = 5;
const OFFSET_MAX = 7 * 24 * 60;

function clampReminderOffset(raw, fallback = 60) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, n));
}

function targetsFromRouting(routing) {
  if (routing === 'tutor') {
    return ['tutor'];
  }
  if (routing === 'both') {
    return ['student', 'tutor'];
  }
  return ['student'];
}

function routingFromTargets(targets) {
  const hasStudent = targets.includes('student');
  const hasTutor = targets.includes('tutor');
  if (hasStudent && hasTutor) {
    return 'both';
  }
  if (hasTutor && !hasStudent) {
    return 'tutor';
  }
  return 'student';
}

function stripDisabledTargets(targets) {
  const filtered = targets.filter((item) => !DISABLED_TARGETS.has(item));
  return filtered.length > 0 ? filtered : ['student'];
}

function normalizeRoutingTargets(raw) {
  if (Array.isArray(raw?.routing_targets)) {
    const unique = [...new Set(raw.routing_targets.filter((item) => TARGETS.has(item)))];
    if (unique.length > 0) {
      return stripDisabledTargets(unique);
    }
  }
  return stripDisabledTargets(targetsFromRouting(String(raw?.routing || 'student')));
}

function normalizeTelegramSettings(raw) {
  const rawOffset = Number(raw?.lesson_reminder_offset_minutes);
  let offset = 60;
  if (Number.isFinite(rawOffset)) {
    if (LEGACY.has(rawOffset) || !BUILTIN.has(rawOffset)) {
      offset = clampReminderOffset(rawOffset);
    } else {
      offset = rawOffset;
    }
  }
  const threshold = Number(raw?.low_balance_threshold);
  const routing_targets = normalizeRoutingTargets(raw);
  return {
    lesson_reminder_enabled: raw?.lesson_reminder_enabled !== false,
    lesson_reminder_offset_minutes: offset,
    low_balance_enabled: Boolean(raw?.low_balance_enabled),
    low_balance_threshold:
      Number.isFinite(threshold) && threshold >= 1 ? Math.min(99, Math.floor(threshold)) : 2,
    payment_receipt_enabled: Boolean(raw?.payment_receipt_enabled),
    routing: routingFromTargets(routing_targets),
    routing_targets,
  };
}

function mapDeliveryError(result) {
  const text = `${result?.error || ''} ${result?.detail || ''}`.toLowerCase();
  if (result?.status === 403 || text.includes('blocked') || text.includes('forbidden')) {
    return 'BOT_BLOCKED';
  }
  if (text.includes('chat not found') || text.includes('chat_not_found')) {
    return 'CHAT_NOT_FOUND';
  }
  if (text.includes('deactivated') || text.includes('user is deactivated')) {
    return 'USER_DEACTIVATED';
  }
  if (text.includes('not_linked') || text.includes('not linked')) {
    return 'NOT_LINKED';
  }
  if (text.includes('bot_inactive') || text.includes('bot inactive')) {
    return 'BOT_INACTIVE';
  }
  return 'UNKNOWN';
}

/** Only these should block future Telegram receipts in CRM. */
function shouldPersistDeliveryError(code) {
  return code === 'BOT_BLOCKED' || code === 'CHAT_NOT_FOUND' || code === 'USER_DEACTIVATED';
}

async function applyNotifyDeliveryOutcome(studentRef, notifyResult, { currentStatus, studentId }) {
  if (notifyResult?.skipped) {
    return null;
  }
  if (notifyResult?.ok) {
    await studentRef.update({
      telegram_delivery_status: 'ok',
      telegram_delivery_error: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { telegram_delivery_status: 'ok', telegram_delivery_error: null };
  }

  const code = mapDeliveryError(notifyResult);
  console.warn(
    '[telegram] notify failed',
    studentId || studentRef.id,
    code,
    notifyResult?.error || notifyResult?.detail || notifyResult?.status,
  );
  if (!shouldPersistDeliveryError(code)) {
    return null;
  }
  await studentRef.update({
    telegram_delivery_status: 'error',
    telegram_delivery_error: code,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { telegram_delivery_status: 'error', telegram_delivery_error: code };
}

module.exports = {
  normalizeTelegramSettings,
  mapDeliveryError,
  shouldPersistDeliveryError,
  applyNotifyDeliveryOutcome,
  clampReminderOffset,
  targetsFromRouting,
  routingFromTargets,
  BUILTIN_REMINDER_OFFSETS: [15, 30, 60, 1440],
};
