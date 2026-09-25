const { db } = require('../firebase');

/** Match lessonBotNotify: complete singles 30m after end. */
const COMPLETE_BUFFER_MS = 30 * 60 * 1000;
/** Safety cap so auto-complete window does not drag ancient scheduled junk. */
const MAX_LESSON_DURATION_MS = 6 * 60 * 60 * 1000;
/** Temporary near-term reminder window (offsets up to ~25h). */
const REMIND_NEAR_MIN_MS = 5 * 60 * 1000;
const REMIND_NEAR_MAX_MS = 25 * 60 * 60 * 1000;
/** Max lesson_reminder_offset_minutes (7 days) — daily pass only. */
const REMIND_LONG_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const REMIND_WINDOW_MS = 90 * 1000;
const DAILY_LONG_REMINDER_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * One range query for the notify tick: covers auto-complete candidates
 * (past starts) and near-term reminders (starts in ~5m…25h).
 * Long offsets (e.g. 1440m) use fetchLongOffsetReminderCandidates on a daily cadence.
 *
 * Requires composite index (status ASC, scheduledAt ASC).
 */
async function fetchCandidateScheduled(now = Date.now()) {
  const lower = new Date(now - COMPLETE_BUFFER_MS - MAX_LESSON_DURATION_MS).toISOString();
  const upper = new Date(now + REMIND_NEAR_MAX_MS + REMIND_WINDOW_MS).toISOString();
  const started = Date.now();
  const snap = await db
    .collection('lessons')
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '>=', lower)
    .where('scheduledAt', '<=', upper)
    .get();
  return {
    docs: snap.docs,
    size: snap.size,
    fetchMs: Date.now() - started,
    lower,
    upper,
  };
}

/**
 * Rare pass for offsets beyond the near window (builtin 1440 / custom up to 7d).
 * scheduledAt ∈ [now+25h − window, now+7d + window].
 */
async function fetchLongOffsetReminderCandidates(now = Date.now()) {
  const lower = new Date(now + REMIND_NEAR_MAX_MS - REMIND_WINDOW_MS).toISOString();
  const upper = new Date(now + REMIND_LONG_MAX_MS + REMIND_WINDOW_MS).toISOString();
  const started = Date.now();
  const snap = await db
    .collection('lessons')
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '>=', lower)
    .where('scheduledAt', '<=', upper)
    .get();
  return {
    docs: snap.docs,
    size: snap.size,
    fetchMs: Date.now() - started,
    lower,
    upper,
  };
}

/**
 * Fallback singles auto-complete when LESSON_BOT_NOTIFY_DISABLED=1.
 * Narrower than full scheduled scan: only plausible past starts.
 */
async function fetchAutoCompleteSingleCandidates(now = Date.now()) {
  const lower = new Date(now - COMPLETE_BUFFER_MS - MAX_LESSON_DURATION_MS).toISOString();
  const upper = new Date(now - COMPLETE_BUFFER_MS).toISOString();
  const started = Date.now();
  const snap = await db
    .collection('lessons')
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '>=', lower)
    .where('scheduledAt', '<=', upper)
    .get();
  return {
    docs: snap.docs,
    size: snap.size,
    fetchMs: Date.now() - started,
    lower,
    upper,
  };
}

/**
 * Recurring series only (isRecurring flag). Single-field equality — no composite index.
 * Legacy docs with rrule but isRecurring!=true are not included; create path always sets both.
 */
async function fetchRecurringLessons() {
  const started = Date.now();
  const snap = await db.collection('lessons').where('isRecurring', '==', true).get();
  return {
    docs: snap.docs,
    size: snap.size,
    fetchMs: Date.now() - started,
  };
}

module.exports = {
  COMPLETE_BUFFER_MS,
  MAX_LESSON_DURATION_MS,
  REMIND_NEAR_MIN_MS,
  REMIND_NEAR_MAX_MS,
  REMIND_LONG_MAX_MS,
  REMIND_WINDOW_MS,
  DAILY_LONG_REMINDER_EVERY_MS,
  fetchCandidateScheduled,
  fetchLongOffsetReminderCandidates,
  fetchAutoCompleteSingleCandidates,
  fetchRecurringLessons,
};
