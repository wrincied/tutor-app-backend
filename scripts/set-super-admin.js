/**
 * Назначить super_admin по email (один раз вручную).
 *
 * Usage:
 *   node scripts/set-super-admin.js user@example.com
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, FieldValue } = require('../src/firebase');

async function main() {
  const email = String(process.argv[2] || '')
    .trim()
    .toLowerCase();
  if (!email) {
    console.error('Usage: node scripts/set-super-admin.js <email>');
    process.exit(1);
  }

  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const doc = snap.docs[0];
  await doc.ref.update({
    role: 'super_admin',
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`OK: ${email} → role=super_admin (uid=${doc.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
