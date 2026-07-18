/**
 * Assign super_admin by email or Firebase UID (one-shot ops).
 *
 * Usage:
 *   node scripts/set-super-admin.js user@example.com
 *   node scripts/set-super-admin.js SNuaQqiQIvgwKkHyzasv0KhZbAU2
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, FieldValue } = require('../src/firebase');

function looksLikeEmail(value) {
  return value.includes('@');
}

async function resolveUserDoc(raw) {
  const key = String(raw || '').trim();
  if (!key) {
    return null;
  }

  if (looksLikeEmail(key)) {
    const email = key.toLowerCase();
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) {
      return null;
    }
    return snap.docs[0];
  }

  const ref = db.collection('users').doc(key);
  const snap = await ref.get();
  if (!snap.exists) {
    return null;
  }
  return snap;
}

async function main() {
  const arg = String(process.argv[2] || '').trim();
  if (!arg) {
    console.error('Usage: node scripts/set-super-admin.js <email|uid>');
    process.exit(1);
  }

  const doc = await resolveUserDoc(arg);
  if (!doc) {
    console.error(`User not found: ${arg}`);
    process.exit(1);
  }

  await doc.ref.update({
    role: 'super_admin',
    updatedAt: FieldValue.serverTimestamp(),
  });

  const email = String(doc.data()?.email || '').trim() || '(no email)';
  console.log(`OK: ${email} → role=super_admin (uid=${doc.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
