const { db } = require('../firebase');

/**
 * Lessons for one tutor in a date window.
 * Always: all recurring series (needed to expand occurrences) + one-offs with
 * scheduledAt in [from-1d, to+2d] (TZ slack).
 * No full-collection fallback — callers must pass from/to.
 *
 * @param {string} tutorId
 * @param {{ from: Date, to: Date }} range
 * @returns {Promise<{ docs: FirebaseFirestore.QueryDocumentSnapshot[], size: number, empty: boolean, forEach: Function }>}
 */
async function fetchTutorLessonsForPeriod(tutorId, { from, to }) {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    const err = new Error('from must be a valid Date');
    err.status = 400;
    throw err;
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    const err = new Error('to must be a valid Date');
    err.status = 400;
    throw err;
  }
  if (from.getTime() > to.getTime()) {
    const err = new Error('from must be <= to');
    err.status = 400;
    throw err;
  }

  const rangeStart = new Date(from);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 1);
  const rangeEnd = new Date(to);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 2);
  rangeEnd.setUTCHours(0, 0, 0, 0);

  const fromIso = rangeStart.toISOString();
  const toIso = rangeEnd.toISOString();

  const [recurringSnap, rangedSnap] = await Promise.all([
    db.collection('lessons').where('tutor', '==', tutorId).where('isRecurring', '==', true).get(),
    db
      .collection('lessons')
      .where('tutor', '==', tutorId)
      .where('scheduledAt', '>=', fromIso)
      .where('scheduledAt', '<', toIso)
      .get(),
  ]);

  const byId = new Map();
  for (const doc of recurringSnap.docs) {
    byId.set(doc.id, doc);
  }
  for (const doc of rangedSnap.docs) {
    byId.set(doc.id, doc);
  }

  return {
    docs: [...byId.values()],
    empty: byId.size === 0,
    size: byId.size,
    forEach(cb) {
      byId.forEach((doc) => cb(doc));
    },
  };
}

module.exports = {
  fetchTutorLessonsForPeriod,
};
