const express = require('express');
const { db, FieldValue } = require('../firebase');
const { beginWebhookEvent, completeWebhookEvent } = require('../utils/webhookEvents');
const { ensureEarlyYearSchedule } = require('../utils/stripeEarlySchedule');
const { applyReferralOnFirstPaid, clearStripeCreditNotice } = require('../utils/referralReward');

const router = express.Router();

function getStripe() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key || key === 'your_stripe_secret_key' || !key.startsWith('sk_')) {
    return null;
  }
  // eslint-disable-next-line global-require
  return require('stripe')(key);
}

function customerIdOf(obj) {
  const customer = obj?.customer;
  if (!customer) {
    return null;
  }
  return typeof customer === 'string' ? customer : customer.id || null;
}

/** Stripe API 2025+ moved invoice.subscription → parent.subscription_details.subscription */
function subscriptionIdOf(invoice) {
  const direct = invoice?.subscription;
  if (typeof direct === 'string' && direct) {
    return direct;
  }
  if (direct?.id) {
    return direct.id;
  }
  const fromParent = invoice?.parent?.subscription_details?.subscription;
  if (typeof fromParent === 'string' && fromParent) {
    return fromParent;
  }
  if (fromParent?.id) {
    return fromParent.id;
  }
  for (const line of invoice?.lines?.data || []) {
    const lineSub =
      line.subscription ||
      line.parent?.subscription_item_details?.subscription ||
      line.parent?.subscription_details?.subscription;
    if (typeof lineSub === 'string' && lineSub) {
      return lineSub;
    }
    if (lineSub?.id) {
      return lineSub.id;
    }
  }
  return null;
}

async function resolveUserIdByEmail(email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }
  const snap = await db.collection('users').where('email', '==', normalized).limit(1).get();
  if (!snap.empty) {
    return snap.docs[0].id;
  }
  // Some profiles store mixed-case email
  const snap2 = await db.collection('users').where('email', '==', String(email).trim()).limit(1).get();
  if (!snap2.empty) {
    return snap2.docs[0].id;
  }
  return null;
}

async function resolveUserId(stripe, { metadataUserId, clientReferenceId, customerId, email }) {
  const fromMeta = String(metadataUserId || clientReferenceId || '').trim();
  if (fromMeta) {
    return fromMeta;
  }
  if (customerId) {
    const snap = await db
      .collection('users')
      .where('stripe_customer_id', '==', customerId)
      .limit(1)
      .get();
    if (!snap.empty) {
      return snap.docs[0].id;
    }
    if (stripe) {
      try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer && !customer.deleted) {
          const byEmail = await resolveUserIdByEmail(customer.email);
          if (byEmail) {
            return byEmail;
          }
          const metaUid = String(customer.metadata?.userId || '').trim();
          if (metaUid) {
            return metaUid;
          }
        }
      } catch (err) {
        console.warn('[billingWebhook] customer lookup failed', customerId, err.message);
      }
    }
  }
  return resolveUserIdByEmail(email);
}

/**
 * Map Stripe subscription → Firestore user.subscription_status.
 */
async function applySubscriptionToUser(userId, subscription) {
  if (!userId || !subscription) {
    return false;
  }

  const status = String(subscription?.status || '');
  const planMeta = String(subscription?.metadata?.plan || '').trim().toLowerCase();
  const pendingMeta = String(subscription?.metadata?.pending_plan || '').trim().toLowerCase();
  const periodEndIso = subscription?.current_period_end
    ? new Date(
        (status === 'trialing' && subscription.trial_end
          ? subscription.trial_end
          : subscription.current_period_end) * 1000,
      ).toISOString()
    : null;
  const interval =
    subscription?.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';

  const patch = {
    subscription_updated_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    cancel_at_period_end: subscription.cancel_at_period_end === true,
    subscription_cancel_at: subscription.cancel_at
      ? new Date(subscription.cancel_at * 1000).toISOString()
      : null,
    subscription_current_period_end: periodEndIso,
    subscription_interval: interval,
  };

  const customerId = customerIdOf(subscription);
  if (customerId) {
    patch.stripe_customer_id = customerId;
  }

  if (status === 'trialing' || status === 'active') {
    patch.proExpiresAt = FieldValue.delete();
    patch.billing_provider = 'stripe';
  }

  if (status === 'trialing') {
    patch.subscription_status = 'trial';
    patch.trial_ends_at = subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null;
  } else if (status === 'active') {
    patch.subscription_status = planMeta === 'basis' ? 'basis' : 'pro';
    patch.trial_ends_at = null;
  } else if (
    status === 'canceled' ||
    status === 'unpaid' ||
    status === 'incomplete_expired' ||
    status === 'paused'
  ) {
    patch.subscription_status = 'free';
    patch.trial_ends_at = null;
    patch.cancel_at_period_end = false;
    patch.subscription_cancel_at = null;
    patch.pending_plan = FieldValue.delete();
    patch.pending_plan_at = FieldValue.delete();
    patch.stripe_schedule_id = FieldValue.delete();
  }
  // incomplete / past_due: keep ids, don't flip plan yet

  if (planMeta === 'basis') {
    patch.pending_plan = FieldValue.delete();
    patch.pending_plan_at = FieldValue.delete();
    patch.stripe_schedule_id = FieldValue.delete();
  } else if (pendingMeta === 'basis' && (status === 'active' || status === 'trialing')) {
    patch.pending_plan = 'basis';
    patch.pending_plan_at = periodEndIso;
  }

  if (subscription.id) {
    patch.stripe_subscription_id = subscription.id;
  }

  const userRef = db.collection('users').doc(userId);
  const existing = await userRef.get();
  if (!existing.exists) {
    console.warn('[billingWebhook] user doc missing', userId);
    return false;
  }

  await userRef.update(patch);
  console.log('[billingWebhook] applied', {
    userId,
    stripeStatus: status,
    planMeta: planMeta || null,
    subscription_status: patch.subscription_status ?? '(unchanged)',
    subscriptionId: subscription.id,
  });
  return Boolean(patch.subscription_status);
}

async function applySubscriptionEvent(stripe, subscription) {
  const userId = await resolveUserId(stripe, {
    metadataUserId: subscription?.metadata?.userId,
    customerId: customerIdOf(subscription),
  });
  if (!userId) {
    console.warn('[billingWebhook] skip: no userId', {
      subscriptionId: subscription?.id,
      metadata: subscription?.metadata || null,
      customer: customerIdOf(subscription),
    });
    return false;
  }
  return applySubscriptionToUser(userId, subscription);
}

async function applyReferralCouponToInvoice(stripe, invoice) {
  const coupon = String(process.env.STRIPE_COUPON_REFERRAL_20 || '').trim();
  if (!coupon || !invoice?.id) {
    return;
  }
  const due = Number(invoice.amount_due ?? invoice.total ?? 0);
  if (due <= 0) {
    return;
  }
  if ((invoice.discounts && invoice.discounts.length) || invoice.discount) {
    return;
  }
  const userId = await resolveUserId(stripe, {
    metadataUserId: invoice.subscription_details?.metadata?.userId || invoice.metadata?.userId,
    customerId: customerIdOf(invoice),
    email: invoice.customer_email,
  });
  if (!userId) {
    return;
  }
  const userSnap = await db.collection('users').doc(userId).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || user.isEarlyAdopter === true || !String(user.referredBy || '').trim()) {
    return;
  }
  const referralSnap = await db.collection('referrals').doc(userId).get();
  if (!referralSnap.exists || referralSnap.data()?.status !== 'pending') {
    return;
  }
  try {
    await stripe.invoices.update(invoice.id, { discounts: [{ coupon }] });
  } catch (err) {
    console.warn('[billingWebhook] referral coupon skip', invoice.id, err.message);
  }
}

async function rewardReferralFromInvoice(stripe, invoice) {
  const amountPaid = Number(invoice.amount_paid || 0);
  const userId = await resolveUserId(stripe, {
    metadataUserId: invoice.subscription_details?.metadata?.userId || invoice.metadata?.userId,
    customerId: customerIdOf(invoice),
    email: invoice.customer_email,
  });
  if (!userId) {
    return;
  }
  if (amountPaid > 0) {
    await clearStripeCreditNotice(db, FieldValue, userId);
  }
  await applyReferralOnFirstPaid({
    db,
    FieldValue,
    stripe,
    payerUid: userId,
    amountPaid,
  });
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !webhookSecret) {
      return res.status(503).json({ message: 'Stripe webhook not configured' });
    }

    const signature = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      return res.status(400).json({ message: `Webhook Error: ${err.message}` });
    }

    console.log('[billingWebhook] event', event.type, event.id);

    const claim = await beginWebhookEvent(db, FieldValue, 'stripe', event.id);
    if (claim === 'duplicate') {
      return res.json({ received: true, duplicate: true });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const sessionStatus = String(session.status || '');
      const paymentStatus = String(session.payment_status || '');
      // Never grant entitlements from metadata alone (abandoned / incomplete sessions).
      if (sessionStatus && sessionStatus !== 'complete') {
        console.warn('[billingWebhook] ignore incomplete checkout session', session.id, sessionStatus);
      } else if (
        paymentStatus &&
        paymentStatus !== 'paid' &&
        paymentStatus !== 'no_payment_required'
      ) {
        console.warn(
          '[billingWebhook] ignore checkout without successful payment',
          session.id,
          paymentStatus,
        );
      } else {
        const userId = await resolveUserId(stripe, {
          metadataUserId: session.metadata?.userId,
          clientReferenceId: session.client_reference_id,
          customerId: customerIdOf(session),
          email: session.customer_email || session.customer_details?.email,
        });
        if (userId && session.subscription) {
          const subId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subId);
          await applySubscriptionToUser(userId, subscription);
          try {
            const scheduleId = await ensureEarlyYearSchedule(stripe, subscription);
            if (scheduleId) {
              await db.collection('users').doc(userId).update({
                stripe_schedule_id: scheduleId,
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          } catch (err) {
            console.warn('[billingWebhook] early schedule failed', subId, err.message);
          }
        } else if (userId) {
          console.warn(
            '[billingWebhook] checkout.session.completed without subscription — skip entitlement',
            session.id,
            userId,
          );
        } else {
          console.warn('[billingWebhook] checkout.session.completed without userId', session.id);
        }
      }
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      await applySubscriptionEvent(stripe, event.data.object);
    }

    if (event.type === 'invoice.created') {
      await applyReferralCouponToInvoice(stripe, event.data.object);
    }

    if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const subId = subscriptionIdOf(invoice);
      if (subId) {
        const subscription = await stripe.subscriptions.retrieve(subId);
        await applySubscriptionEvent(stripe, subscription);
      } else {
        console.warn('[billingWebhook] invoice without subscription id', invoice.id);
      }
      await rewardReferralFromInvoice(stripe, invoice);
    }

    await completeWebhookEvent(db, FieldValue, 'stripe', event.id);
    res.json({ received: true });
  } catch (error) {
    console.error('[billingWebhook] error', error);
    next(error);
  }
});

module.exports = router;
module.exports.applySubscriptionToUser = applySubscriptionToUser;
module.exports.resolveUserId = resolveUserId;
module.exports.customerIdOf = customerIdOf;
