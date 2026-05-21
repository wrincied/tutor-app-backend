const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  lessonIncomeFromSnapshot,
  lessonScheduledRevenueFromSnapshot,
  enrichLessonSnapshot,
} = require('./lessonSnapshot');

describe('lessonSnapshot finance', () => {
  it('counts completed income from hourly snapshot', () => {
    const income = lessonIncomeFromSnapshot({
      status: 'completed',
      lesson_price: 40,
      lesson_duration: 90,
    });
    assert.equal(income, 60);
  });

  it('counts scheduled planned revenue', () => {
    const planned = lessonScheduledRevenueFromSnapshot({
      status: 'scheduled',
      lesson_price: 30,
      lesson_duration: 60,
    });
    assert.equal(planned, 30);
  });

  it('enriches missing price from student', () => {
    const students = new Map([
      ['s1', { rate_per_hour: 50, rate_currency: 'EUR', timezone: 'Europe/Vienna' }],
    ]);
    const lesson = enrichLessonSnapshot(
      { status: 'scheduled', student_id: 's1', lesson_duration: 60 },
      students,
    );
    assert.equal(lessonScheduledRevenueFromSnapshot(lesson), 50);
  });

  it('replaces zero snapshot price with student rate', () => {
    const students = new Map([
      ['s1', { rate_per_hour: 40, rate_currency: 'EUR', timezone: 'Europe/Vienna' }],
    ]);
    const lesson = enrichLessonSnapshot(
      {
        status: 'scheduled',
        student_id: 's1',
        lesson_duration: 60,
        lesson_price: 0,
        lesson_currency: 'EUR',
        student_timezone: 'UTC',
      },
      students,
    );
    assert.equal(lesson.lesson_price, 40);
    assert.equal(lessonScheduledRevenueFromSnapshot(lesson), 40);
  });
});
