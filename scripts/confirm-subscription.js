/**
 * Ручная активация подписки после подтверждённой оплаты (прод / поддержка).
 *
 * Usage:
 *   node scripts/confirm-subscription.js user@example.com pro
 *   node scripts/confirm-subscription.js user@example.com trial
 *
 * Requires in backend/.env:
 *   BILLING_ADMIN_SECRET=your-long-random-secret
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, FieldValue } = require('../src/firebase');
const { isTaxModeConfigured, subscriptionLabel } = require('../src/utils/userProfile');

async function main() {
  const email = String(process.argv[2] || '')
    .trim()
    .toLowerCase();
  const plan = subscriptionLabel(process.argv[3] || 'pro');

  if (!email) {
    console.error('Usage: node scripts/confirm-subscription.js <email> <pro|trial>');
    process.exit(1);
  }
  if (plan !== 'pro' && plan !== 'trial') {
    console.error('Plan must be pro or trial');
    process.exit(1);
  }
  if (!process.env.BILLING_ADMIN_SECRET) {
    console.error('Set BILLING_ADMIN_SECRET in backend/.env');
    process.exit(1);
  }

  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const doc = snap.docs[0];
  const data = doc.data();
  if (!isTaxModeConfigured(data.tax_mode)) {
    console.error('User has no tax regime configured. They must set it in Account first.');
    process.exit(1);
  }

  await doc.ref.update({
    subscription_status: plan,
    subscription_updated_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`OK: ${email} → subscription_status=${plan}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
