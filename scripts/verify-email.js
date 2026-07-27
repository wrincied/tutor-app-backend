/**
 * Проверка / подтверждение email в Firebase Auth (без письма).
 *
 * Запуск из папки backend:
 *   node scripts/verify-email.js check  friend@example.com
 *   node scripts/verify-email.js verify friend@example.com
 *   node scripts/verify-email.js verify <firebaseUid>
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { admin, db, FieldValue } = require('../src/firebase');

const mode = (process.argv[2] || '').trim().toLowerCase();
const target = (process.argv[3] || '').trim();

async function resolveUser(arg) {
  if (arg.includes('@')) {
    return admin.auth().getUserByEmail(arg.toLowerCase());
  }
  return admin.auth().getUser(arg);
}

async function main() {
  if (!process.env.FIREBASE_PROJECT_ID) {
    console.error('В .env не задан FIREBASE_PROJECT_ID.');
    process.exit(1);
  }
  if ((mode !== 'check' && mode !== 'verify') || !target) {
    console.error('Usage:');
    console.error('  node scripts/verify-email.js check  <email|uid>');
    console.error('  node scripts/verify-email.js verify <email|uid>');
    process.exit(1);
  }

  const before = await resolveUser(target);
  console.log('Auth user:');
  console.log('  uid:           ', before.uid);
  console.log('  email:         ', before.email || '(none)');
  console.log('  emailVerified: ', before.emailVerified);

  const userDoc = await db.collection('users').doc(before.uid).get();
  if (userDoc.exists) {
    console.log('Firestore users/' + before.uid + ':');
    console.log('  email_verified:', userDoc.data().email_verified === true);
  } else {
    console.log('Firestore: документ users/' + before.uid + ' не найден');
  }

  if (mode === 'check') {
    return;
  }

  if (before.emailVerified) {
    console.log('\nУже verified в Auth. Синхронизирую Firestore…');
  } else {
    await admin.auth().updateUser(before.uid, { emailVerified: true });
    console.log('\nAuth: emailVerified → true');
  }

  await db.collection('users').doc(before.uid).set(
    {
      email_verified: true,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  console.log('Firestore: email_verified → true');

  const after = await admin.auth().getUser(before.uid);
  console.log('\nПосле:');
  console.log('  emailVerified: ', after.emailVerified);
  console.log('Другу: выйти из приложения и войти снова (нужен новый ID token).');
}

main().catch((err) => {
  console.error(err?.errorInfo || err);
  process.exit(1);
});
