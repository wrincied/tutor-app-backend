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

  it('prefers unpaid_debt flag when present', () => {
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
      {
        _id: 'paid',
        status: 'completed',
        scheduledAt: '2026-08-01T10:00:00.000Z',
        lesson_duration: 60,
        balance_debited: true,
        settled_by_payment_at: '2026-08-01T12:00:00.000Z',
      },
    ];

    const unpaid = selectUnpaidLessonsForSettlement(lessons, student, 'lesson');
    assert.deepEqual(
      unpaid.map((l) => l._id),
      ['a', 'b'],
    );
  });
});
