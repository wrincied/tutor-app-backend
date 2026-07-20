const { db } = require('../firebase');

/**
 * Имя репетитора для сообщений ученику в Telegram.
 */
function formatTutorDisplayName(userData) {
  if (!userData || typeof userData !== 'object') {
    return null;
  }
  const first = String(userData.first_name || '').trim();
  const last = String(userData.last_name || '').trim();
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) {
    return combined;
  }
  const name = String(userData.name || '').trim();
  return name || null;
}

async function resolveTutorName(tutorId) {
  if (!tutorId) {
    return null;
  }
  try {
    const snap = await db.collection('users').doc(String(tutorId)).get();
    if (!snap.exists) {
      return null;
    }
    return formatTutorDisplayName(snap.data());
  } catch (err) {
    console.error('resolveTutorName:', err.message);
    return null;
  }
}

module.exports = {
  formatTutorDisplayName,
  resolveTutorName,
};
