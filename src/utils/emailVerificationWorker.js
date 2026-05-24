const cron = require('node-cron');
const { db } = require('../firebase');
const { isEmailVerified } = require('./emailVerification');

const CRON_SCHEDULE = '0 */6 * * *';

async function deleteUserCascade(userId) {
  const studentsSnap = await db.collection('students').where('tutor_id', '==', userId).get();
  const lessonsSnap = await db.collection('lessons').where('tutor', '==', userId).get();
  const expensesSnap = await db.collection('expenses').where('tutor', '==', userId).get();

  const batch = db.batch();
  studentsSnap.forEach((doc) => batch.delete(doc.ref));
  lessonsSnap.forEach((doc) => batch.delete(doc.ref));
  expensesSnap.forEach((doc) => batch.delete(doc.ref));
  batch.delete(db.collection('users').doc(userId));
  await batch.commit();
}

async function purgeUnverifiedAccounts() {
  const now = new Date();
  const snap = await db.collection('users').where('email_verified', '==', false).get();

  const toDelete = [];
  snap.forEach((doc) => {
    const data = doc.data();
    if (isEmailVerified(data)) {
      return;
    }
    const purgeRaw = data.account_purge_at;
    if (!purgeRaw) {
      return;
    }
    const purgeMs =
      typeof purgeRaw.toDate === 'function' ? purgeRaw.toDate().getTime() : Date.parse(purgeRaw);
    if (!Number.isNaN(purgeMs) && purgeMs <= now.getTime()) {
      toDelete.push(doc.id);
    }
  });

  for (const userId of toDelete) {
    try {
      await deleteUserCascade(userId);
      console.info(`[emailVerificationWorker] purged unverified user ${userId}`);
    } catch (error) {
      console.error(`[emailVerificationWorker] failed user ${userId}:`, error.message);
    }
  }

  return toDelete.length;
}

function startEmailVerificationWorker() {
  if (process.env.EMAIL_VERIFICATION_WORKER_ENABLED === 'false') {
    return;
  }
  cron.schedule(CRON_SCHEDULE, () => {
    purgeUnverifiedAccounts().catch((error) => {
      console.error('[emailVerificationWorker] cycle error:', error);
    });
  });
  console.info('[emailVerificationWorker] purge job every 6 hours (3 day unverified accounts)');
}

module.exports = {
  startEmailVerificationWorker,
  purgeUnverifiedAccounts,
  deleteUserCascade,
};
