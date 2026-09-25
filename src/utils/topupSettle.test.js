const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectUnpaidLessonsForSettlement } = require('./topupSettle');

describe('selectUnpaidLessonsForSettlement', () => {
  it('FIFO: with balance -2 both debt lessons are unpaid, oldest first', () => {
    const student = {
      billing_type: 'package',
      rate_unit: 'lesson',
      balance_lessons: -2,
    };
    const lessons = [
      {
        _id: 'old',
        status: 'completed',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        lesson_duration: 60,
        balance_debited: true,
      },
      {
        _id: 'new',
        status: 'completed',
        scheduledAt: '2026-09-10T10:00:00.000Z',
        lesson_duration: 60,
        balance_debited: true,
      },
    ];

    const unpaid = selectUnpaidLessonsForSettlement(lessons, student, 'lesson');
    assert.deepEqual(
      unpaid.map((l) => l._id),
      ['old', 'new'],
    );
  });

  it('after +1 settlement only the newer unpaid remains', () => {
    const student = {
      billing_type: 'package',
      rate_unit: 'lesson',
      balance_lessons: -1,
    };
    const lessons = [
      {
        _id: 'old',
        status: 'completed',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        lesson_duration: 60,
        balance_debited: true,
        settled_by_payment_at: '2026-09-14T10:00:00.000Z',
      },
      {
        _id: 'new',
        status: 'completed',
        scheduledAt: '2026-09-10T10:00:00.000Z',
        lesson_duration: 60,
        balance_debited: true,
      },
    ];

    const unpaid = selectUnpaidLessonsForSettlement(lessons, student, 'lesson');
    assert.deepEqual(
      unpaid.map((l) => l._id),
      ['new'],
    );
  });

  it('caps unpaid_debt flags by open package debt (not all flagged lessons)', () => {
    const student = {
      billing_type: 'package',
      rate_unit: 'hour',
      balance_lessons: -0.5,
    };
    const lessons = [
      {
        _id: 'a',
        status: 'completed',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
        balance_units_debited: 1,
      },
      {
        _id: 'b',
        status: 'completed',
        scheduledAt: '2026-09-08T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
        balance_units_debited: 1,
      },
      {
        _id: 'c',
        status: 'completed',
        scheduledAt: '2026-09-15T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
        balance_units_debited: 1,
      },
      {
        _id: 'd',
        status: 'completed',
        scheduledAt: '2026-09-24T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
        balance_units_debited: 1,
      },
    ];

    const unpaid = selectUnpaidLessonsForSettlement(lessons, student, 'hour');
    // Newest covering 0.5h debt → only the latest flagged lesson (24th), not the 14th/1st.
    assert.deepEqual(
      unpaid.map((l) => l._id),
      ['d'],
    );
  });

  it('hides orphan unpaid_debt when open debt is already 0', () => {
    const student = {
      billing_type: 'package',
      rate_unit: 'lesson',
      balance_lessons: 0,
    };
    const lessons = [
      {
        _id: 'a',
        status: 'completed',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
      },
      {
        _id: 'b',
        status: 'completed',
        scheduledAt: '2026-09-02T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
      },
    ];

    assert.deepEqual(selectUnpaidLessonsForSettlement(lessons, student, 'lesson'), []);
    assert.deepEqual(
      selectUnpaidLessonsForSettlement(lessons, student, 'lesson', {
        includeOrphanFlags: true,
      }).map((l) => l._id),
      ['a', 'b'],
    );
  });

  it('includes unpaid_debt on scheduled recurring when debt remains', () => {
    const student = {
      billing_type: 'package',
      rate_unit: 'hour',
      balance_lessons: -1,
    };
    const lessons = [
      {
        _id: 'occ',
        status: 'scheduled',
        scheduledAt: '2026-09-21T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
        balance_units_debited: 1,
      },
    ];

    const unpaid = selectUnpaidLessonsForSettlement(lessons, student, 'hour');
    assert.deepEqual(
      unpaid.map((l) => l._id),
      ['occ'],
    );
  });

  it('postpaid caps merged unpaid by net debt units', () => {
    const student = {
      billing_type: 'postpaid',
      rate_unit: 'lesson',
      unpaid_lessons_count: 1,
      balance_lessons: 0,
    };
    const lessons = [
      {
        _id: 'flagged',
        status: 'completed',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
      },
      {
        _id: 'legacy',
        status: 'missed',
        scheduledAt: '2026-09-05T10:00:00.000Z',
        lesson_duration: 60,
        billing_processed: true,
        balance_debited: false,
      },
      {
        _id: 'settled',
        status: 'completed',
        scheduledAt: '2026-09-03T10:00:00.000Z',
        lesson_duration: 60,
        unpaid_debt: true,
        settled_by_payment_at: '2026-09-10T10:00:00.000Z',
      },
    ];

    const unpaid = selectUnpaidLessonsForSettlement(lessons, student, 'lesson');
    assert.deepEqual(
      unpaid.map((l) => l._id),
      ['flagged'],
    );
  });
});

describe('resolveUnpaidLessonScheduledAt', () => {
  const { resolveUnpaidLessonScheduledAt } = require('./topupSettle');

  it('uses billable occurrence day for recurring, not series anchor', () => {
    const lesson = {
      isRecurring: true,
      rrule: 'FREQ=WEEKLY',
      scheduledAt: '2026-09-14T10:00:00.000Z',
      completedDates: ['2026-09-21', '2026-09-28'],
      missedDates: [],
    };
    const at = resolveUnpaidLessonScheduledAt(lesson, { preferNewest: true });
    assert.equal(at.slice(0, 10), '2026-09-28');
    const oldest = resolveUnpaidLessonScheduledAt(lesson, { preferNewest: false });
    assert.equal(oldest.slice(0, 10), '2026-09-21');
  });

  it('keeps one-off scheduledAt', () => {
    const at = resolveUnpaidLessonScheduledAt({
      scheduledAt: '2026-09-14T10:00:00.000Z',
      status: 'completed',
    });
    assert.equal(at, '2026-09-14T10:00:00.000Z');
  });
});
