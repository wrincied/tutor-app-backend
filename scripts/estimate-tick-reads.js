/**
 * Models Firestore document reads per worker tick (lessons + balance_logs checks only).
 * Run: node backend/scripts/estimate-tick-reads.js
 *
 * Defaults are placeholders — override via env:
 *   TOTAL_LESSONS, SCHEDULED_LESSONS, RECURRING_LESSONS,
 *   CANDIDATE_WINDOW_LESSONS, COMPLETED_UNBILLED,
 *   RECURRING_WITH_COMPLETED_DATES, AVG_COMPLETED_DATES_PER_SERIES,
 *   AVG_BALANCE_LOGS_PER_LESSON_OLD
 */
function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

const TOTAL = num('TOTAL_LESSONS', 5000);
const SCHEDULED = num('SCHEDULED_LESSONS', 2000);
const RECURRING = num('RECURRING_LESSONS', 80);
const WINDOW = num('CANDIDATE_WINDOW_LESSONS', 40); // ~6.5h back … +25h ahead among scheduled
const COMPLETED_UNBILLED = num('COMPLETED_UNBILLED', 5);
const RECURRING_WITH_DATES = num('RECURRING_WITH_COMPLETED_DATES', 40);
const AVG_DATES = num('AVG_COMPLETED_DATES_PER_SERIES', 8);
const AVG_LOGS_OLD = num('AVG_BALANCE_LOGS_PER_LESSON_OLD', 30); // capped at 100 in old code

function estimate() {
  // --- BEFORE (pre-optimization) ---
  // tick: reminders full scheduled + autoComplete full scheduled
  // billing: autoComplete recurring full scheduled + billDue full collection
  //         + delayed: completed & !billing_processed
  // balance_logs: up to min(100, logs) per completedDate checked
  const beforeLessons =
    SCHEDULED + // reminders
    SCHEDULED + // autoComplete singles path
    SCHEDULED + // autoComplete recurring
    TOTAL + // billDue recurring
    COMPLETED_UNBILLED; // delayed singles (assume query returns only these)

  const balanceChecksBefore = RECURRING_WITH_DATES * AVG_DATES;
  const beforeBalanceLogs = balanceChecksBefore * Math.min(100, AVG_LOGS_OLD);

  // --- AFTER ---
  // one candidate window for reminders+autoComplete singles
  // one recurring fetch shared by both recurring paths
  // delayed same
  // balance_logs: 0 or 1 per check
  const afterLessons = WINDOW + RECURRING + COMPLETED_UNBILLED;
  const afterBalanceLogs = balanceChecksBefore * 1; // limit(1) — charge 1 even if empty? Firestore: 0 if empty for queries... actually empty queries that don't read docs cost minimally; if exists, 1 read. Worst case assume 1 per check when looking for match - unmatched still may scan index. Count as 1 read per query that returns a doc, ~0-1. Use 1 as upper for matched path; for all checks use 1 as conservative (each query billed for returned docs only — empty = 0). Use 0.5 avg.

  const afterBalanceLogsConservative = balanceChecksBefore * 1;

  const beforeTotal = beforeLessons + beforeBalanceLogs;
  const afterTotal = afterLessons + afterBalanceLogsConservative;
  const drop = beforeTotal - afterTotal;
  const factor = beforeTotal / Math.max(1, afterTotal);

  const perHourBefore = beforeTotal * 60;
  const perHourAfter = afterTotal * 60;

  return {
    inputs: {
      TOTAL,
      SCHEDULED,
      RECURRING,
      WINDOW,
      COMPLETED_UNBILLED,
      RECURRING_WITH_DATES,
      AVG_DATES,
      AVG_LOGS_OLD,
      balanceChecksPerTick: balanceChecksBefore,
    },
    perTick: {
      before: { lessons: beforeLessons, balance_logs: beforeBalanceLogs, total: beforeTotal },
      after: { lessons: afterLessons, balance_logs: afterBalanceLogsConservative, total: afterTotal },
      drop,
      dropPct: Math.round((1 - afterTotal / beforeTotal) * 1000) / 10,
      factor: Math.round(factor * 10) / 10,
    },
    perHour: {
      before: perHourBefore,
      after: perHourAfter,
      drop: perHourBefore - perHourAfter,
    },
    per2_5h: {
      before: Math.round(perHourBefore * 2.5),
      after: Math.round(perHourAfter * 2.5),
      note: 'Compare to earlier ~43K screenshot window if that was mostly tick reads',
    },
  };
}

const result = estimate();
console.log(JSON.stringify(result, null, 2));

module.exports = { estimate };
