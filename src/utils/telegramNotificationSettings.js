const OFFSETS = new Set([15, 60, 120, 1440]);
const ROUTINGS = new Set(['student', 'tutor', 'both']);
const TARGETS = new Set(['student', 'parent', 'tutor']);

function normalizeTelegramSettings(raw) {
  const offset = Number(raw?.lesson_reminder_offset_minutes);
  const threshold = Number(raw?.low_balance_threshold);
  const routing = String(raw?.routing || 'student');
  const targets = Array.isArray(raw?.routing_targets)
    ? raw.routing_targets.filter((item) => TARGETS.has(item))
    : undefined;
  return {
    lesson_reminder_enabled: raw?.lesson_reminder_enabled !== false,
    lesson_reminder_offset_minutes: OFFSETS.has(offset) ? offset : 60,
    low_balance_enabled: Boolean(raw?.low_balance_enabled),
    low_balance_threshold:
      Number.isFinite(threshold) && threshold >= 1 ? Math.min(99, Math.floor(threshold)) : 2,
    payment_receipt_enabled: Boolean(raw?.payment_receipt_enabled),
    routing: ROUTINGS.has(routing) ? routing : 'student',
    ...(targets && targets.length ? { routing_targets: targets } : {}),
  };
}

function mapDeliveryError(result) {
  const text = String(result?.error || '').toLowerCase();
  if (result?.status === 403 || text.includes('blocked') || text.includes('forbidden')) {
    return 'BOT_BLOCKED';
  }
  if (text.includes('chat not found') || text.includes('chat_not_found')) {
    return 'CHAT_NOT_FOUND';
  }
  if (text.includes('deactivated') || text.includes('user is deactivated')) {
    return 'USER_DEACTIVATED';
  }
  return 'UNKNOWN';
}

module.exports = {
  normalizeTelegramSettings,
  mapDeliveryError,
};
