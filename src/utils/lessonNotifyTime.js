const { db } = require('../firebase');

function formatLessonTimeLabel(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timeZone || 'Europe/Vienna',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 16);
  }
}

async function resolveTutorTimezone(tutorId) {
  if (!tutorId) {
    return 'Europe/Vienna';
  }
  try {
    const snap = await db.collection('users').doc(String(tutorId)).get();
    if (!snap.exists) {
      return 'Europe/Vienna';
    }
    const tz = snap.data()?.timezone;
    return tz ? String(tz) : 'Europe/Vienna';
  } catch {
    return 'Europe/Vienna';
  }
}

function scheduleTimesEqual(left, right) {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return String(left || '') === String(right || '');
  }
  return a === b;
}

module.exports = {
  formatLessonTimeLabel,
  resolveTutorTimezone,
  scheduleTimesEqual,
};
