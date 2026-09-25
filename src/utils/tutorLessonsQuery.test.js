const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fetchTutorLessonsForPeriod } = require('./tutorLessonsQuery');

describe('fetchTutorLessonsForPeriod validation', () => {
  it('rejects invalid from/to before Firestore', async () => {
    await assert.rejects(
      () => fetchTutorLessonsForPeriod('tutor-1', { from: null, to: new Date() }),
      (e) => e.status === 400 && /from must be a valid Date/.test(e.message),
    );
    await assert.rejects(
      () =>
        fetchTutorLessonsForPeriod('tutor-1', {
          from: new Date('2026-05-02'),
          to: new Date('2026-05-01'),
        }),
      (e) => e.status === 400 && /from must be <= to/.test(e.message),
    );
  });
});
