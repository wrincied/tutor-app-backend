const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BUFFER_MS,
  completedAtMs,
  isLessonDueForBilling,
  filterDueLessons,
  computeStudentBillingUpdate,
} = require('./billingWorker');

describe('completedAtMs', () => {
  it('returns null when completed_at is missing', () => {
    assert.equal(completedAtMs({}), null);
  });

  it('parses ISO string', () => {
    const ms = completedAtMs({ completed_at: '2026-05-19T10:00:00.000Z' });
    assert.equal(ms, Date.parse('2026-05-19T10:00:00.000Z'));
  });

  it('reads Firestore Timestamp-like objects', () => {
    const ms = completedAtMs({
      completed_at: { toDate: () => new Date('2026-05-19T10:00:00.000Z') },
    });
    assert.equal(ms, Date.parse('2026-05-19T10:00:00.000Z'));
  });

  it('returns null for invalid date', () => {
    assert.equal(completedAtMs({ completed_at: 'not-a-date' }), null);
  });
});

describe('isLessonDueForBilling', () => {
  const now = Date.parse('2026-05-19T12:00:00.000Z');
  const completedAt = new Date(now - BUFFER_MS).toISOString();

  it('returns false for non-completed lessons', () => {
    assert.equal(
      isLessonDueForBilling({ status: 'scheduled', billing_processed: false, completed_at: completedAt }, now),
      false,
    );
  });

  it('returns false when already processed', () => {
    assert.equal(
      isLessonDueForBilling({ status: 'completed', billing_processed: true, completed_at: completedAt }, now),
      false,
    );
  });

  it('returns false inside buffer window', () => {
    const recent = new Date(now - BUFFER_MS + 1000).toISOString();
    assert.equal(
      isLessonDueForBilling({ status: 'completed', billing_processed: false, completed_at: recent }, now),
      false,
    );
  });

  it('returns true when buffer elapsed', () => {
    assert.equal(
      isLessonDueForBilling({ status: 'completed', billing_processed: false, completed_at: completedAt }, now),
      true,
    );
  });
});

describe('filterDueLessons', () => {
  const now = Date.parse('2026-05-19T12:00:00.000Z');
  const dueCompletedAt = new Date(now - BUFFER_MS).toISOString();
  const recentCompletedAt = new Date(now - BUFFER_MS + 5000).toISOString();

  const lessons = [
    { id: 'due', status: 'completed', billing_processed: false, completed_at: dueCompletedAt },
    { id: 'recent', status: 'completed', billing_processed: false, completed_at: recentCompletedAt },
    { id: 'processed', status: 'completed', billing_processed: true, completed_at: dueCompletedAt },
    { id: 'scheduled', status: 'scheduled', billing_processed: false, completed_at: dueCompletedAt },
  ];

  it('keeps only completed, unprocessed lessons past buffer', () => {
    const due = filterDueLessons(lessons, now);
    assert.deepEqual(due.map((lesson) => lesson.id), ['due']);
  });
});

describe('computeStudentBillingUpdate', () => {
  it('decrements package balance', () => {
    const result = computeStudentBillingUpdate({ balance_lessons: 5, billing_type: 'package' });
    assert.deepEqual(result, {
      billingType: 'package',
      studentPatch: { balance_lessons: 4 },
      balanceLog: { amount: -1, reason: 'lesson_completed_delayed' },
      balanceDebited: true,
    });
  });

  it('treats invalid package balance as zero before debit', () => {
    const result = computeStudentBillingUpdate({ balance_lessons: 'x', billing_type: 'package' });
    assert.equal(result.studentPatch.balance_lessons, -1);
  });

  it('increments unpaid count for postpaid', () => {
    const result = computeStudentBillingUpdate({ unpaid_lessons_count: 2, billing_type: 'postpaid' });
    assert.deepEqual(result, {
      billingType: 'postpaid',
      studentPatch: { unpaid_lessons_count: 3 },
      balanceLog: { amount: 1, reason: 'lesson_completed_postpaid' },
      balanceDebited: false,
    });
  });

  it('normalizes per_lesson alias to postpaid', () => {
    const result = computeStudentBillingUpdate({ unpaid_lessons_count: 0, billing_type: 'per_lesson' });
    assert.equal(result.billingType, 'postpaid');
    assert.equal(result.studentPatch.unpaid_lessons_count, 1);
  });
});
