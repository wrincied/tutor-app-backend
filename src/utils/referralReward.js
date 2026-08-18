const { getPlanPricing, resolvePricingCountry, toStripeUnitAmount } = require('./subscriptionPricing');
const { trialEndsMs } = require('./trialExpiry');

function addDays(from, days) {
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function proExpiresPatch(referrerData, now, FieldValue) {
  const currentMs = trialEndsMs(referrerData?.proExpiresAt);
  const baseMs = currentMs && currentMs > now.getTime() ? currentMs : now.getTime();
  const next = addDays(new Date(baseMs), 30);
  return {
    subscription_status: 'pro',
    proExpiresAt: next.toISOString(),
    billing_provider: referrerData?.billing_provider || 'admin',
    trial_ends_at: FieldValue.delete(),
    subscription_updated_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * First live payment (amountPaid > 0) of a pending referral.
 * Stripe customer → balance credit of one Pro month. Else proExpiresAt + 30d.
 */
async function applyReferralOnFirstPaid({ db, FieldValue, stripe, payerUid, amountPaid, now = new Date() }) {
  const paid = Number(amountPaid) || 0;
  if (!payerUid || paid <= 0) {
    return { rewarded: false, reason: 'not_paid' };
  }

  const referralRef = db.collection('referrals').doc(payerUid);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(referralRef);
    if (!snap.exists) {
      return null;
    }
    const data = snap.data() || {};
    if (data.status !== 'pending') {
      return { already: true, referrerUid: data.referrerUid };
    }
    tx.update(referralRef, {
      status: 'rewarded',
      rewardedAt: FieldValue.serverTimestamp(),
    });
    return { already: false, referrerUid: data.referrerUid };
  });

  if (!claimed) {
    return { rewarded: false, reason: 'no_referral' };
  }
  if (claimed.already) {
    return { rewarded: false, reason: 'already_rewarded', referrerUid: claimed.referrerUid };
  }

  const referrerUid = String(claimed.referrerUid || '').trim();
  if (!referrerUid) {
    return { rewarded: false, reason: 'missing_referrer' };
  }

  const referrerRef = db.collection('users').doc(referrerUid);
  const referrerSnap = await referrerRef.get();
  if (!referrerSnap.exists) {
    return { rewarded: false, reason: 'referrer_missing', referrerUid };
  }

  const referrer = referrerSnap.data() || {};
  const customerId = String(referrer.stripe_customer_id || '').trim();
  if (customerId && stripe) {
    const country = resolvePricingCountry(referrer.tax_mode, referrer.country_settings);
    const pricing = getPlanPricing('pro', country);
    const currency = String(pricing.currency || 'EUR').toLowerCase();
    const amount = -toStripeUnitAmount(pricing.monthly, currency);
    await stripe.customers.createBalanceTransaction(customerId, {
      amount,
      currency,
      description: 'Simple4U referral: 1 month Pro credit',
      metadata: { source: 'referral', refereeUid: payerUid },
    });
    await referrerRef.update({
      stripe_credit_notice: {
        amount: pricing.monthly,
        currency: pricing.currency,
        source: 'referral',
        createdAt: now.toISOString(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { rewarded: true, kind: 'stripe_credit', referrerUid, amount: pricing.monthly, currency: pricing.currency };
  }

  await referrerRef.update(proExpiresPatch(referrer, now, FieldValue));
  return { rewarded: true, kind: 'pro_expires', referrerUid };
}

async function clearStripeCreditNotice(db, FieldValue, userId) {
  if (!userId) {
    return;
  }
  const ref = db.collection('users').doc(userId);
  const snap = await ref.get();
  if (!snap.exists || !snap.data()?.stripe_credit_notice) {
    return;
  }
  await ref.update({
    stripe_credit_notice: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

module.exports = {
  addDays,
  proExpiresPatch,
  applyReferralOnFirstPaid,
  clearStripeCreditNotice,
};
