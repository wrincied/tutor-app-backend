const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  lessonIncomeFromSnapshot,
  lessonScheduledRevenueFromSnapshot,
  lessonRevenueFromSnapshot,
  enrichLessonSnapshot,
  normalizePriceMode,
  studentSnapshotFromStudent,
} = require('./lessonSnapshot');

describe('lessonSnapshot finance', () => {
  it('counts completed income from hourly snapshot', () => {
    const income = lessonIncomeFromSnapshot({
      status: 'completed',
      lesson_price: 40,
      lesson_duration: 90,
      price_mode: 'hourly',
    });
    assert.equal(income, 60);
  });

  it('uses fixed price without duration scaling', () => {
    const income = lessonIncomeFromSnapshot({
      status: 'completed',
      lesson_price: 40,
      lesson_duration: 90,
      price_mode: 'fixed',
    });
    assert.equal(income, 40);
  });

  it('counts scheduled planned revenue', () => {
    const planned = lessonScheduledRevenueFromSnapshot({
      status: 'scheduled',
      lesson_price: 30,
      lesson_duration: 60,
    });
    assert.equal(planned, 30);
  });

  it('maps student rate_unit lesson to fixed price_mode', () => {
    const snapshot = studentSnapshotFromStudent({
      rate_per_hour: 55,
      rate_currency: 'EUR',
      rate_unit: 'lesson',
      timezone: 'Europe/Vienna',
    });
    assert.equal(snapshot.price_mode, 'fixed');
    assert.equal(snapshot.lesson_price, 55);
  });

  it('normalizePriceMode defaults to hourly', () => {
    assert.equal(normalizePriceMode(), 'hourly');
    assert.equal(normalizePriceMode('fixed'), 'fixed');
  });

  it('enriches missing price from student including price_mode', () => {
    const students = new Map([
      ['s1', { rate_per_hour: 50, rate_currency: 'EUR', rate_unit: 'lesson', timezone: 'Europe/Vienna' }],
    ]);
    const lesson = enrichLessonSnapshot(
      { status: 'scheduled', student_id: 's1', lesson_duration: 90 },
      students,
    );
    assert.equal(lesson.price_mode, 'fixed');
    assert.equal(lessonRevenueFromSnapshot(lesson), 50);
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
    assert.equal(lesson.price_mode, 'hourly');
    assert.equal(lessonScheduledRevenueFromSnapshot(lesson), 40);
  });
});
