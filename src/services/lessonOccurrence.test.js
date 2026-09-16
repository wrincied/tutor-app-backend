const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sumBalanceLogNet,
  autoCompletePastRecurringOccurrences,
  normalizeOccurrenceDate,
  uniqueDates,
} = require('./lessonOccurrence');

describe('sumBalanceLogNet', () => {
  it('sums package debits as negative net for one occurrence', () => {
    const rows = [
      { occurrenceDate: '2026-09-01', amount: -1 },
      { occurrenceDate: '2026-09-02', amount: -1 },
    ];
    assert.equal(sumBalanceLogNet(rows, '2026-09-01'), -1);
  });

  it('nets debit + refund to zero', () => {
    const rows = [
      { occurrenceDate: '2026-09-01', amount: -1, reason: 'lesson_completed_occurrence' },
      { occurrenceDate: '2026-09-01', amount: 1, reason: 'lesson_occurrence_deleted_refund' },
    ];
    assert.equal(sumBalanceLogNet(rows, '2026-09-01'), 0);
  });

  it('sums all logs for a lesson when occurrenceDate is omitted', () => {
    const rows = [
      { occurrenceDate: '2026-09-01', amount: -1 },
      { occurrenceDate: '2026-09-02', amount: -1 },
      { occurrenceDate: null, amount: -1 },
    ];
    assert.equal(sumBalanceLogNet(rows), -3);
  });

  it('ignores non-finite amounts', () => {
    const rows = [{ occurrenceDate: '2026-09-01', amount: 'x' }, { amount: -0.5 }];
    assert.equal(sumBalanceLogNet(rows), -0.5);
  });
});

describe('autoCompletePastRecurringOccurrences', () => {
  it('does not auto-complete or debit past occurrences', async () => {
    const result = await autoCompletePastRecurringOccurrences(Date.now());
    assert.deepEqual(result, { completed: 0 });
  });
});

describe('normalizeOccurrenceDate / uniqueDates', () => {
  it('normalizes YYYY-MM-DD', () => {
    assert.equal(normalizeOccurrenceDate('2026-09-16T12:00:00Z'), '2026-09-16');
    assert.equal(normalizeOccurrenceDate('bad'), null);
  });

  it('dedupes dates', () => {
    assert.deepEqual(uniqueDates(['2026-09-01', '2026-09-01', '2026-09-02']), [
      '2026-09-01',
      '2026-09-02',
    ]);
  });
});
