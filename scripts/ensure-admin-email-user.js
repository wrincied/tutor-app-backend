/**
 * Ensure Firebase Auth user admin@simple4u.at exists with emailVerified,
 * and Firestore users/{uid}.role = super_admin.
 *
 * Usage:
 *   ADMIN_BOOTSTRAP_PASSWORD='...' node scripts/ensure-admin-email-user.js
 *
 * Optional: ADMIN_EMAIL=admin@simple4u.at
 */
require('dotenv').config();
const { admin, db, FieldValue } = require('../src/firebase');

const email = String(process.env.ADMIN_EMAIL || 'admin@simple4u.at')
  .trim()
  .toLowerCase();
const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '').trim();

async function main() {
  if (!password || password.length < 8) {
    console.error('Set ADMIN_BOOTSTRAP_PASSWORD (min 8 chars) in the environment.');
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log('Auth user exists', user.uid);
    await admin.auth().updateUser(user.uid, {
      password,
      emailVerified: true,
      disabled: false,
    });
    console.log('Updated password + emailVerified');
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') {
      throw err;
    }
    user = await admin.auth().createUser({
      email,
      password,
      emailVerified: true,
      disabled: false,
    });
    console.log('Created Auth user', user.uid);
  }

  const ref = db.collection('users').doc(user.uid);
  const snap = await ref.get();
  const base = {
    email,
    firebase_uid: user.uid,
    email_verified: true,
    role: 'super_admin',
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!snap.exists) {
    await ref.set({
      ...base,
      first_name: 'Admin',
      last_name: '',
      name: 'Admin',
      onboarding_completed: true,
      data_consent_accepted: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('Created Firestore profile super_admin');
  } else {
    await ref.set(base, { merge: true });
    console.log('Updated Firestore profile → super_admin');
  }

  console.log('Done. Sign in at /admin-login with', email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
