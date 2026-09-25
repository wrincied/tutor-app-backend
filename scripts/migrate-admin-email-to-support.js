/**
 * Rename Firebase Auth admin email admin@ → support@ (same UID → all data stays).
 *
 * If support@ already exists as a different Auth user, fails with instructions.
 *
 * Usage (from backend/, with .env service account):
 *   node scripts/migrate-admin-email-to-support.js
 *   FROM_ADMIN_EMAIL=admin@simple4u.at TO_ADMIN_EMAIL=support@simple4u.at node ...
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { admin, db, FieldValue } = require('../src/firebase');

const FROM = String(process.env.FROM_ADMIN_EMAIL || 'admin@simple4u.at')
  .trim()
  .toLowerCase();
const TO = String(process.env.TO_ADMIN_EMAIL || 'support@simple4u.at')
  .trim()
  .toLowerCase();

async function main() {
  if (FROM === TO) {
    throw new Error('FROM and TO emails must differ');
  }

  let fromUser;
  try {
    fromUser = await admin.auth().getUserByEmail(FROM);
  } catch (err) {
    if (err?.code === 'auth/user-not-found') {
      throw new Error(`Source Auth user not found: ${FROM}`);
    }
    throw err;
  }

  let toUser = null;
  try {
    toUser = await admin.auth().getUserByEmail(TO);
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') {
      throw err;
    }
  }

  if (toUser && toUser.uid !== fromUser.uid) {
    throw new Error(
      `Target ${TO} already exists as uid=${toUser.uid}, source is uid=${fromUser.uid}. ` +
        `Delete or rename the target Auth user first, then re-run.`,
    );
  }

  console.log(`Auth: ${FROM} (${fromUser.uid}) → ${TO}`);
  await admin.auth().updateUser(fromUser.uid, {
    email: TO,
    emailVerified: true,
    disabled: false,
  });
  console.log('Auth email updated');

  const ref = db.collection('users').doc(fromUser.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      email: TO,
      firebase_uid: fromUser.uid,
      email_verified: true,
      role: 'super_admin',
      first_name: 'Admin',
      last_name: '',
      name: 'Admin',
      onboarding_completed: true,
      data_consent_accepted: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log('Created Firestore users doc as super_admin');
  } else {
    await ref.set(
      {
        email: TO,
        firebase_uid: fromUser.uid,
        email_verified: true,
        role: 'super_admin',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    console.log('Updated Firestore users doc email + super_admin');
  }

  // Demote any other profile still labeled with old email (shouldn't exist after Auth rename).
  const stale = await db.collection('users').where('email', '==', FROM).get();
  for (const doc of stale.docs) {
    if (doc.id === fromUser.uid) {
      continue;
    }
    await doc.ref.set(
      { role: 'tutor', updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    console.log(`Demoted stale profile uid=${doc.id}`);
  }

  console.log('Done. Sign in at /admin-login with', TO);
  console.log('Also set App Hosting secret ADMIN_EMAILS=' + TO);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
