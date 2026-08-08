const express = require('express');
const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const billingAuth = [auth, requireVerifiedEmail];
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const {
  canPurchasePlan,
  enrichUserProfile,
  subscriptionLabel,
} = require('../utils/userProfile');
const {
  getPlanPricing,
  getStripePriceIdForCountry,
  resolvePricingCountry,
  toStripeUnitAmount,
} = require('../utils/subscriptionPricing');
const { spaDeepLink } = require('../utils/corsOrigins');

const router = express.Router();

/** Pro free trial length for Stripe Checkout subscriptions. */
const PRO_TRIAL_DAYS = 14;

function getStripe() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key || key === 'your_stripe_secret_key' || !key.startsWith('sk_')) {
    return null;
  }
  // eslint-disable-next-line global-require
  return require('stripe')(key);
}

function isStripeTestMode() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  return key.startsWith('sk_test_');
}

async function loadUser(userId) {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) {
    return null;
  }
  return serializeDoc(snap);
}

async function resolveStripeSubscriptionId(stripe, user) {
  const pickBest = (subs) => {
    const ranked = (subs || []).filter((s) => s.status === 'trialing' || s.status === 'active');
    if (!ranked.length) {
      return null;
    }
    ranked.sort((a, b) => (b.created || 0) - (a.created || 0));
    return ranked[0];
  };

  const existing = String(user.stripe_subscription_id || '').trim();
  if (existing) {
    try {
      const current = await stripe.subscriptions.retrieve(existing);
      if (current.status === 'trialing' || current.status === 'active') {
        // Still verify there isn't a newer active sub on same email/customer
      } else {
        // fall through to search
      }
    } catch {
      // fall through
    }
  }

  const customerId = String(user.stripe_customer_id || '').trim();
  if (customerId) {
    const listed = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    });
    const match = pickBest(listed.data);
    if (match?.id) {
      return match.id;
    }
  }

  const email = String(user.email || '').trim();
  if (!email) {
    // Fallback to stored id even if canceled search failed
    return existing || null;
  }
  const customers = await stripe.customers.list({ email, limit: 20 });
  /** @type {import('stripe').Stripe.Subscription[]} */
  const all = [];
  for (const customer of customers.data) {
    const listed = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 20,
    });
    all.push(...listed.data);
  }
  const best = pickBest(all);
  if (best?.id) {
    return best.id;
  }
  if (existing) {
    try {
      const current = await stripe.subscriptions.retrieve(existing);
      if (current.status === 'trialing' || current.status === 'active') {
        return existing;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Prefer a configured Stripe Price when its currency matches displayed pricing.
 * Otherwise build price_data so UA sees UAH 399, not a silent EUR 9.99 fallback.
 */
async function buildCheckoutLineItem(stripe, pricing, interval, plan = 'pro') {
  const amount = interval === 'yearly' ? pricing.yearly : pricing.monthly;
  const currency = String(pricing.currency || 'EUR').toLowerCase();
  const configuredId = getStripePriceIdForCountry(pricing.country, interval, plan);
  let productId = null;

  if (configuredId) {
    const price = await stripe.prices.retrieve(configuredId);
    productId = typeof price.product === 'string' ? price.product : price.product?.id;
    if (String(price.currency || '').toLowerCase() === currency) {
      return { price: configuredId, quantity: 1 };
    }
  }

  if (!productId) {
    const fallbackId =
      process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID_PRO_MONTHLY;
    if (fallbackId) {
      const fallback = await stripe.prices.retrieve(fallbackId);
      productId =
        typeof fallback.product === 'string' ? fallback.product : fallback.product?.id;
    }
  }

  const productName = plan === 'basis' ? 'Simple4U Basis' : 'Simple4U Pro';

  if (productId) {
    return {
      price_data: {
        currency,
        product: productId,
        unit_amount: toStripeUnitAmount(amount, currency),
        recurring: { interval: interval === 'yearly' ? 'year' : 'month' },
      },
      quantity: 1,
    };
  }

  return {
    price_data: {
      currency,
      product_data: { name: productName },
      unit_amount: toStripeUnitAmount(amount, currency),
      recurring: { interval: interval === 'yearly' ? 'year' : 'month' },
    },
    quantity: 1,
  };
}

/**
 * Resolve a Stripe Price id for an existing subscription change.
 * Prefers configured env prices; otherwise creates a matching Price.
 */
async function resolvePlanPriceId(stripe, pricing, interval, plan = 'pro') {
  const amount = interval === 'yearly' ? pricing.yearly : pricing.monthly;
  const currency = String(pricing.currency || 'EUR').toLowerCase();
  const configuredId = getStripePriceIdForCountry(pricing.country, interval, plan);

  if (configuredId) {
    const price = await stripe.prices.retrieve(configuredId);
    if (String(price.currency || '').toLowerCase() === currency) {
      return configuredId;
    }
  }

  const lineItem = await buildCheckoutLineItem(stripe, pricing, interval, plan);
  if (lineItem.price) {
    return lineItem.price;
  }

  const priceData = lineItem.price_data;
  if (!priceData) {
    return null;
  }

  /** @type {import('stripe').Stripe.PriceCreateParams} */
  const createParams = {
    currency: priceData.currency,
    unit_amount: priceData.unit_amount,
    recurring: priceData.recurring,
  };
  if (priceData.product) {
    createParams.product = priceData.product;
  } else if (priceData.product_data) {
    createParams.product_data = priceData.product_data;
  }

  const created = await stripe.prices.create(createParams);
  return created.id;
}

/** POST /api/billing/checkout-session — Stripe Checkout (только при настроенном налоговом режиме). */
router.post('/checkout-session', billingAuth, async (req, res, next) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const plan = req.body?.plan === 'basis' ? 'basis' : 'pro';
    if (!canPurchasePlan(user, plan === 'basis' ? 'basis' : 'trial')) {
      return res.status(403).json({
        message:
          plan === 'basis'
            ? 'Basis is only available from Free after tax regime is set'
            : 'Set your tax regime in Account before purchasing a subscription',
      });
    }

    const stripe = getStripe();
    const pricingCountry = resolvePricingCountry(user.tax_mode, user.country_settings);
    const pricing = getPlanPricing(plan, pricingCountry);
    const interval = req.body?.interval === 'yearly' ? 'yearly' : 'monthly';

    if (!stripe) {
      return res.status(503).json({
        message:
          'Stripe is not configured (STRIPE_SECRET_KEY). For local sandbox: set sk_test_ in .env and run node scripts/setup-stripe-sandbox.js --write',
      });
    }

    const lineItem = await buildCheckoutLineItem(stripe, pricing, interval, plan);
    if (!lineItem) {
      return res.status(503).json({
        message:
          'Stripe is not configured (STRIPE_PRICE_ID_PRO or STRIPE_PRICE_ID_PRO_XX). For local sandbox: run node scripts/setup-stripe-sandbox.js --write',
      });
    }

    const meta = {
      userId: req.user.id,
      plan: plan === 'basis' ? 'basis' : 'trial',
      interval,
      pricingCountry,
      pricingCurrency: pricing.currency,
      stripeMode: isStripeTestMode() ? 'test' : 'live',
      trialDays: plan === 'pro' ? String(PRO_TRIAL_DAYS) : '0',
    };

    /** @type {import('stripe').Stripe.Checkout.SessionCreateParams} */
    const sessionParams = {
      mode: 'subscription',
      client_reference_id: req.user.id,
      line_items: [lineItem],
      managed_payments: { enabled: false },
      success_url: spaDeepLink('/app/home', { billing: 'success' }),
      cancel_url: spaDeepLink('/app/pricing', { billing: 'cancel' }),
      metadata: meta,
    };

    // Reuse Stripe customer so webhooks/sync don't spawn orphan customers per checkout.
    const existingCustomerId = String(user.stripe_customer_id || '').trim();
    if (existingCustomerId) {
      sessionParams.customer = existingCustomerId;
    } else {
      sessionParams.customer_email = user.email;
    }

    if (plan === 'pro') {
      sessionParams.subscription_data = {
        trial_period_days: PRO_TRIAL_DAYS,
        metadata: meta,
      };
    } else {
      sessionParams.subscription_data = {
        metadata: meta,
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({
      url: session.url,
      pricing,
      plan,
      trialDays: plan === 'pro' ? PRO_TRIAL_DAYS : 0,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/change-plan
 * Downgrade Pro/Trial → Basis on the existing Stripe subscription (no new Checkout).
 * Body: { plan: 'basis' }
 */
router.post('/change-plan', billingAuth, async (req, res, next) => {
  try {
    const targetPlan = req.body?.plan === 'basis' ? 'basis' : null;
    if (!targetPlan) {
      return res.status(400).json({ message: 'Only plan=basis is supported for change-plan' });
    }

    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe is not configured' });
    }

    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const current = subscriptionLabel(user.subscription_status);
    if (current !== 'pro' && current !== 'trial') {
      return res.status(403).json({
        message: 'Basis downgrade is only available from Pro or Trial',
      });
    }

    const subId = await resolveStripeSubscriptionId(stripe, user);
    if (!subId) {
      return res.status(400).json({
        message: 'No active Stripe subscription on this account',
      });
    }

    const subscription = await stripe.subscriptions.retrieve(subId);
    const item = subscription.items?.data?.[0];
    if (!item?.id) {
      return res.status(400).json({ message: 'Subscription has no billable items' });
    }

    const interval =
      item.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
    const pricingCountry = resolvePricingCountry(user.tax_mode, user.country_settings);
    const pricing = getPlanPricing('basis', pricingCountry);
    const priceId = await resolvePlanPriceId(stripe, pricing, interval, 'basis');
    if (!priceId) {
      return res.status(503).json({
        message: 'Could not resolve a Stripe price for Basis',
      });
    }

    const meta = {
      ...(subscription.metadata || {}),
      userId: req.user.id,
      plan: 'basis',
      interval,
      pricingCountry,
      pricingCurrency: pricing.currency,
      stripeMode: isStripeTestMode() ? 'test' : 'live',
      trialDays: '0',
    };

    /** @type {import('stripe').Stripe.SubscriptionUpdateParams} */
    const updateParams = {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
      metadata: meta,
    };
    if (subscription.status === 'trialing') {
      updateParams.trial_end = 'now';
    }

    const updatedSub = await stripe.subscriptions.update(subId, updateParams);

    await db.collection('users').doc(req.user.id).update({
      stripe_subscription_id: subId,
      stripe_customer_id:
        typeof updatedSub.customer === 'string'
          ? updatedSub.customer
          : updatedSub.customer?.id || user.stripe_customer_id || null,
      subscription_status: 'basis',
      trial_ends_at: null,
      cancel_at_period_end: false,
      subscription_cancel_at: null,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = enrichUserProfile(
      serializeDoc(await db.collection('users').doc(req.user.id).get()),
    );
    const { password_hash: _ph, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/cancel-subscription
 * Cancel at period end (keeps Pro/Trial until trial_end / current_period_end).
 */
router.post('/cancel-subscription', billingAuth, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe is not configured' });
    }

    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const subId = await resolveStripeSubscriptionId(stripe, user);
    if (!subId) {
      return res.status(400).json({
        message: 'No active Stripe subscription on this account',
      });
    }

    const subscription = await stripe.subscriptions.update(subId, {
      cancel_at_period_end: true,
    });

    const cancelAt = subscription.cancel_at
      ? new Date(subscription.cancel_at * 1000).toISOString()
      : subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null;

    await db.collection('users').doc(req.user.id).update({
      stripe_subscription_id: subId,
      stripe_customer_id:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id || user.stripe_customer_id || null,
      cancel_at_period_end: true,
      subscription_cancel_at: cancelAt,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = enrichUserProfile(serializeDoc(await db.collection('users').doc(req.user.id).get()));
    const { password_hash: _ph, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/resume-subscription
 * Undo cancel_at_period_end while the subscription is still active/trialing.
 */
router.post('/resume-subscription', billingAuth, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe is not configured' });
    }

    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const subId = await resolveStripeSubscriptionId(stripe, user);
    if (!subId) {
      return res.status(400).json({ message: 'No active Stripe subscription on this account' });
    }

    await stripe.subscriptions.update(subId, { cancel_at_period_end: false });

    await db.collection('users').doc(req.user.id).update({
      stripe_subscription_id: subId,
      cancel_at_period_end: false,
      subscription_cancel_at: null,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = enrichUserProfile(serializeDoc(await db.collection('users').doc(req.user.id).get()));
    const { password_hash: _ph, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/sync-subscription
 * Pull active Stripe subscription for the current user and mirror plan into Firestore.
 * Used after Checkout return when webhooks race / were missed.
 */
router.post('/sync-subscription', billingAuth, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe is not configured' });
    }

    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const subId = await resolveStripeSubscriptionId(stripe, user);
    if (!subId) {
      return res.status(404).json({ message: 'No active Stripe subscription found' });
    }

    const subscription = await stripe.subscriptions.retrieve(subId);
    const status = String(subscription.status || '');
    const planMeta = String(subscription.metadata?.plan || '').trim().toLowerCase();

    const patch = {
      stripe_subscription_id: subscription.id,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      cancel_at_period_end: subscription.cancel_at_period_end === true,
      subscription_cancel_at: subscription.cancel_at
        ? new Date(subscription.cancel_at * 1000).toISOString()
        : null,
    };

    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;
    if (customerId) {
      patch.stripe_customer_id = customerId;
    }

    if (status === 'trialing') {
      patch.subscription_status = 'trial';
      patch.trial_ends_at = subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null;
    } else if (status === 'active') {
      patch.subscription_status = planMeta === 'basis' ? 'basis' : 'pro';
      patch.trial_ends_at = null;
    } else {
      return res.status(409).json({
        message: `Subscription status is ${status}, expected active/trialing`,
        stripe_status: status,
      });
    }

    // Ensure metadata can resolve webhooks later
    if (!subscription.metadata?.userId || !subscription.metadata?.plan) {
      await stripe.subscriptions.update(subscription.id, {
        metadata: {
          ...(subscription.metadata || {}),
          userId: req.user.id,
          plan: planMeta || (status === 'trialing' ? 'trial' : 'pro'),
        },
      });
    }

    await db.collection('users').doc(req.user.id).update(patch);

    const updated = enrichUserProfile(serializeDoc(await db.collection('users').doc(req.user.id).get()));
    const { password_hash: _ph, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/confirm-payment
 * Ручное подтверждение оплаты (прод: только с BILLING_ADMIN_SECRET).
 * Body: { plan: 'pro' | 'trial', adminSecret: string }
 */
router.post('/confirm-payment', billingAuth, async (req, res, next) => {
  try {
    const adminSecret = process.env.BILLING_ADMIN_SECRET;
    if (!adminSecret || String(req.body.adminSecret) !== adminSecret) {
      return res.status(403).json({ message: 'Invalid admin secret' });
    }

    const plan = subscriptionLabel(req.body.plan);
    if (plan !== 'pro' && plan !== 'trial') {
      return res.status(400).json({ message: 'plan must be pro or trial' });
    }

    const userRef = db.collection('users').doc(req.user.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = serializeDoc(userSnap);
    const { isTaxModeConfigured } = require('../utils/userProfile');
    if (!isTaxModeConfigured(user.tax_mode)) {
      return res.status(403).json({ message: 'Tax regime must be configured first' });
    }

    await userRef.update({
      subscription_status: plan,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = enrichUserProfile(serializeDoc(await userRef.get()));
    const { password_hash: _ph, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
