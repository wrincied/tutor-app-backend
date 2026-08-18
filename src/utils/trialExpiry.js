const { subscriptionLabel } = require('./userProfile');

function trialEndsMs(value) {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value.toDate === 'function') {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function shouldExpireTrial(user, now = Date.now()) {
  if (subscriptionLabel(user?.subscription_status) !== 'trial') {
    return false;
  }
  if (String(user?.stripe_subscription_id || '').trim()) {
    return false;
  }
  const ends = trialEndsMs(user?.trial_ends_at);
  return ends != null && ends <= now;
}

function expiredTrialPatch(FieldValue) {
  return {
    subscription_status: 'free',
    trial_ends_at: FieldValue.delete(),
    billing_provider: FieldValue.delete(),
    cancel_at_period_end: false,
    subscription_cancel_at: FieldValue.delete(),
    subscription_updated_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function shouldExpireManualPro(user, now = Date.now()) {
  if (subscriptionLabel(user?.subscription_status) !== 'pro') {
    return false;
  }
  if (String(user?.stripe_subscription_id || '').trim()) {
    return false;
  }
  const ends = trialEndsMs(user?.proExpiresAt);
  return ends != null && ends <= now;
}

function expiredManualProPatch(FieldValue) {
  return {
    ...expiredTrialPatch(FieldValue),
    proExpiresAt: FieldValue.delete(),
  };
}

/**
 * Downgrade admin/manual trials past trial_ends_at and manual Pro past proExpiresAt.
 * Stripe-linked accounts are left to webhooks. isEarlyAdopter is kept.
 */
async function expireEndedTrials(db, FieldValue, now = new Date()) {
  const nowMs = now.getTime();
  let expired = 0;
  const trialSnap = await db.collection('users').where('subscription_status', '==', 'trial').get();
  for (const doc of trialSnap.docs) {
    if (!shouldExpireTrial(doc.data(), nowMs)) {
      continue;
    }
    await doc.ref.update(expiredTrialPatch(FieldValue));
    expired += 1;
  }
  const proSnap = await db.collection('users').where('subscription_status', '==', 'pro').get();
  for (const doc of proSnap.docs) {
    if (!shouldExpireManualPro(doc.data(), nowMs)) {
      continue;
    }
    await doc.ref.update(expiredManualProPatch(FieldValue));
    expired += 1;
  }
  return expired;
}

module.exports = {
  trialEndsMs,
  shouldExpireTrial,
  shouldExpireManualPro,
  expiredTrialPatch,
  expiredManualProPatch,
  expireEndedTrials,
};
