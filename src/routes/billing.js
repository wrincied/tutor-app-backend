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
const { spaPathLink } = require('../utils/corsOrigins');
const {
  paymentProviderForCountry,
  resolvePaymentProvider,
} = require('../utils/paymentProvider');
const {
  isTributeConfigured,
  createTributeShopOrder,
  cancelTributeShopOrder,
} = require('../utils/tribute');

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

function stripeUnixToIso(unix) {
  if (!unix || !Number.isFinite(Number(unix))) {
    return null;
  }
  return new Date(Number(unix) * 1000).toISOString();
}

function subscriptionIntervalOf(subscription) {
  const item = subscription?.items?.data?.[0];
  return item?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
}

function subscriptionPeriodEndUnix(subscription) {
  if (subscription?.status === 'trialing' && subscription.trial_end) {
    return subscription.trial_end;
  }
  if (subscription?.current_period_end) {
    return subscription.current_period_end;
  }
  // Newer Stripe API: period lives on subscription items.
  const itemEnd = subscription?.items?.data?.[0]?.current_period_end;
  return itemEnd || null;
}

function priceIdOfPhaseItem(item) {
  if (!item) {
    return null;
  }
  if (typeof item.price === 'string') {
    return item.price;
  }
  return item.price?.id || null;
}

/**
 * Schedule Pro/Trial → Basis at current_period_end (keeps Pro entitlements until then).
 * Important: once a schedule manages the subscription, do NOT call subscriptions.update
 * (Stripe returns 400). Metadata goes on the schedule / phases instead.
 */
async function scheduleBasisDowngradeAtPeriodEnd(stripe, subscription, basisPriceId, phaseMeta) {
  const keepMeta = {
    ...(subscription.metadata || {}),
    pending_plan: 'basis',
  };
  if (!keepMeta.plan || keepMeta.plan === 'basis') {
    keepMeta.plan = subscription.status === 'trialing' ? 'trial' : 'pro';
  }

  const existingScheduleId =
    typeof subscription.schedule === 'string'
      ? subscription.schedule
      : subscription.schedule?.id || null;

  // Metadata on the subscription must be set before it becomes schedule-managed.
  if (!existingScheduleId) {
    await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: false,
      metadata: keepMeta,
    });
  }

  let schedule;
  if (existingScheduleId) {
    schedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId);
  } else {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    });
  }

  const currentPhase = schedule.phases?.[0];
  if (!currentPhase) {
    throw Object.assign(new Error('Subscription schedule has no current phase'), { status: 500 });
  }

  // Prefer the schedule's own phase end — Stripe rejects mismatched end_date (400).
  const periodEnd =
    currentPhase.end_date ||
    subscriptionPeriodEndUnix(subscription);
  if (!periodEnd) {
    throw Object.assign(new Error('Subscription has no period end'), { status: 400 });
  }

  const currentItems = (currentPhase.items || [])
    .map((item) => {
      const price = priceIdOfPhaseItem(item);
      if (!price) {
        return null;
      }
      return { price, quantity: item.quantity || 1 };
    })
    .filter(Boolean);

  if (!currentItems.length) {
    throw Object.assign(new Error('Subscription schedule phase has no items'), { status: 500 });
  }

  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    metadata: {
      ...phaseMeta,
      pending_plan: 'basis',
    },
    phases: [
      {
        start_date: currentPhase.start_date,
        end_date: periodEnd,
        items: currentItems,
        proration_behavior: 'none',
        metadata: keepMeta,
      },
      {
        start_date: periodEnd,
        items: [{ price: basisPriceId, quantity: 1 }],
        proration_behavior: 'none',
        metadata: {
          ...phaseMeta,
          plan: 'basis',
          pending_plan: '',
        },
      },
    ],
  });

  return {
    scheduleId: schedule.id,
    periodEndIso: stripeUnixToIso(periodEnd),
    interval: subscriptionIntervalOf(subscription),
  };
}

async function releaseSubscriptionScheduleIfAny(stripe, subscription) {
  const scheduleId =
    typeof subscription.schedule === 'string'
      ? subscription.schedule
      : subscription.schedule?.id || null;
  if (!scheduleId) {
    return;
  }
  try {
    await stripe.subscriptionSchedules.release(scheduleId);
  } catch (err) {
    // Already released / completed — ignore.
    if (err?.code !== 'resource_missing') {
      console.warn('[billing] schedule release failed', scheduleId, err.message);
    }
  }
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

/** GET /api/billing/payment-options — which rail this account must use. */
router.get('/payment-options', billingAuth, async (req, res, next) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    const plan = req.query?.plan === 'basis' ? 'basis' : 'pro';
    const pricingCountry = resolvePricingCountry(user.tax_mode, user.country_settings);
    const preferredProvider = paymentProviderForCountry(pricingCountry);
    const tributeReady = isTributeConfigured();
    const stripeReady = Boolean(getStripe());
    const provider = resolvePaymentProvider(pricingCountry, { tributeReady, stripeReady });
    res.json({
      country: pricingCountry,
      preferredProvider,
      provider,
      fallbackUsed: preferredProvider === 'tribute' && provider === 'stripe',
      tributeReady,
      stripeReady,
      trialDays: plan === 'pro' ? (provider === 'tribute' ? 7 : PRO_TRIAL_DAYS) : 0,
    });
  } catch (error) {
    next(error);
  }
});

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
    const tributeReady = isTributeConfigured();
    const provider = resolvePaymentProvider(pricingCountry, {
      tributeReady,
      stripeReady: Boolean(stripe),
    });
    if (provider !== 'stripe') {
      return res.status(409).json({
        message: 'This account must pay with Tribute',
        provider,
      });
    }
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
      success_url: `${spaPathLink('/app/home', { billing: 'success' })}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: spaPathLink('/app/pricing', { billing: 'cancel' }),
      metadata: meta,
    };

    // Reuse Stripe customer so webhooks/sync don't spawn orphan customers per checkout.
    // Stale IDs happen after test→live key switch or deleted customers.
    const existingCustomerId = String(user.stripe_customer_id || '').trim();
    if (existingCustomerId) {
      try {
        const customer = await stripe.customers.retrieve(existingCustomerId);
        if (customer && !customer.deleted) {
          sessionParams.customer = existingCustomerId;
        } else {
          throw Object.assign(new Error('deleted'), { code: 'resource_missing' });
        }
      } catch (err) {
        if (err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing') {
          console.warn('[billing] stale stripe_customer_id, recreating', existingCustomerId);
          await db.collection('users').doc(req.user.id).update({
            stripe_customer_id: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          sessionParams.customer_email = user.email;
        } else {
          throw err;
        }
      }
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

    await db.collection('users').doc(req.user.id).update({
      stripe_checkout_session_id: session.id,
      updatedAt: FieldValue.serverTimestamp(),
    });

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
 * POST /api/billing/tribute/checkout-session — Tribute Shop order (CIS only).
 */
router.post('/tribute/checkout-session', billingAuth, async (req, res, next) => {
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

    const pricingCountry = resolvePricingCountry(user.tax_mode, user.country_settings);
    const tributeReady = isTributeConfigured();
    const provider = resolvePaymentProvider(pricingCountry, {
      tributeReady,
      stripeReady: Boolean(getStripe()),
    });
    if (provider !== 'tribute') {
      return res.status(409).json({
        message: tributeReady
          ? 'This account must pay with Stripe'
          : 'Tribute is not ready yet; use Stripe checkout for now',
        provider,
      });
    }

    if (!tributeReady) {
      return res.status(503).json({
        message:
          'Tribute is not configured yet (TRIBUTE_API_KEY). Add the key and shop webhook, then retry.',
        provider,
      });
    }

    const interval = req.body?.interval === 'yearly' ? 'yearly' : 'monthly';
    const order = await createTributeShopOrder({
      plan,
      interval,
      country: pricingCountry,
      userId: req.user.id,
      email: user.email,
      successUrl: spaPathLink('/app/payment', { billing: 'success' }),
      failUrl: spaPathLink('/app/payment', { billing: 'cancel' }),
    });

    await db.collection('users').doc(req.user.id).update({
      billing_provider: 'tribute',
      tribute_order_uuid: order?.uuid || user.tribute_order_uuid || null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const url = order?.paymentUrl || order?.webappPaymentUrl || null;
    if (!url) {
      return res.status(502).json({
        message: 'Tribute did not return a payment URL',
        provider,
      });
    }

    res.json({
      url,
      provider,
      plan,
      trialDays: plan === 'pro' ? 7 : 0,
      orderUuid: order.uuid || null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/billing/change-plan
 * Schedule Pro/Trial → Basis at period end (Pro + Telegram stay until then).
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

    if (String(user.billing_provider || '') === 'tribute') {
      return res.status(400).json({
        message:
          'Tribute does not support in-place plan change. Cancel the current plan, then buy Basis from Payment.',
      });
    }

    const current = subscriptionLabel(user.subscription_status);
    if (current !== 'pro' && current !== 'trial') {
      return res.status(403).json({
        message: 'Basis downgrade is only available from Pro or Trial',
      });
    }

    if (String(user.pending_plan || '').toLowerCase() === 'basis') {
      const updated = enrichUserProfile(
        serializeDoc(await db.collection('users').doc(req.user.id).get()),
      );
      const { password_hash: _ph, ...safeUser } = updated;
      return res.json(safeUser);
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

    const interval = subscriptionIntervalOf(subscription);
    const pricingCountry = resolvePricingCountry(user.tax_mode, user.country_settings);
    const pricing = getPlanPricing('basis', pricingCountry);
    const priceId = await resolvePlanPriceId(stripe, pricing, interval, 'basis');
    if (!priceId) {
      return res.status(503).json({
        message: 'Could not resolve a Stripe price for Basis',
      });
    }

    const phaseMeta = {
      userId: req.user.id,
      plan: 'basis',
      interval,
      pricingCountry,
      pricingCurrency: pricing.currency,
      stripeMode: isStripeTestMode() ? 'test' : 'live',
      trialDays: '0',
    };

    const scheduled = await scheduleBasisDowngradeAtPeriodEnd(
      stripe,
      subscription,
      priceId,
      phaseMeta,
    );

    await db.collection('users').doc(req.user.id).update({
      stripe_subscription_id: subId,
      stripe_customer_id:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id || user.stripe_customer_id || null,
      // Keep Pro/Trial until period end — Basis applies then via Stripe schedule.
      cancel_at_period_end: false,
      subscription_cancel_at: null,
      pending_plan: 'basis',
      pending_plan_at: scheduled.periodEndIso,
      subscription_current_period_end: scheduled.periodEndIso,
      subscription_interval: scheduled.interval,
      stripe_schedule_id: scheduled.scheduleId,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = enrichUserProfile(
      serializeDoc(await db.collection('users').doc(req.user.id).get()),
    );
    const { password_hash: _ph, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    console.error('[billing/change-plan]', {
      message: error?.message,
      type: error?.type,
      code: error?.code,
      statusCode: error?.statusCode,
      raw: error?.raw?.message,
    });
    next(error);
  }
});

/**
 * POST /api/billing/cancel-subscription
 * Cancel at period end (keeps Pro/Trial until trial_end / current_period_end).
 */
router.post('/cancel-subscription', billingAuth, async (req, res, next) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const tributeUuid = String(user.tribute_order_uuid || '').trim();
    if (String(user.billing_provider || '') === 'tribute' || tributeUuid) {
      if (!isTributeConfigured()) {
        return res.status(503).json({ message: 'Tribute is not configured' });
      }
      if (!tributeUuid) {
        return res.status(400).json({ message: 'No Tribute subscription on this account' });
      }
      await cancelTributeShopOrder(tributeUuid);
      const cancelAt = user.trial_ends_at || user.subscription_cancel_at || null;
      await db.collection('users').doc(req.user.id).update({
        cancel_at_period_end: true,
        subscription_cancel_at: cancelAt,
        subscription_updated_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      const updated = enrichUserProfile(
        serializeDoc(await db.collection('users').doc(req.user.id).get()),
      );
      const { password_hash: _ph, ...safeUser } = updated;
      return res.json(safeUser);
    }

    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe is not configured' });
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

    const subscription = await stripe.subscriptions.retrieve(subId);
    await releaseSubscriptionScheduleIfAny(stripe, subscription);

    const meta = { ...(subscription.metadata || {}) };
    delete meta.pending_plan;
    await stripe.subscriptions.update(subId, {
      cancel_at_period_end: false,
      metadata: meta,
    });

    await db.collection('users').doc(req.user.id).update({
      stripe_subscription_id: subId,
      cancel_at_period_end: false,
      subscription_cancel_at: null,
      pending_plan: FieldValue.delete(),
      pending_plan_at: FieldValue.delete(),
      stripe_schedule_id: FieldValue.delete(),
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
 * POST /api/billing/confirm-checkout-session
 * Body: { sessionId: 'cs_...' }
 * Verifies Stripe Checkout completed for this user before entitlements stick.
 */
router.post('/confirm-checkout-session', billingAuth, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe is not configured' });
    }

    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ message: 'sessionId is required' });
    }

    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const sessionUserId =
      String(session.client_reference_id || '').trim() ||
      String(session.metadata?.userId || '').trim();
    if (sessionUserId && sessionUserId !== req.user.id) {
      return res.status(403).json({ message: 'Checkout session does not belong to this user' });
    }

    const complete =
      session.status === 'complete' &&
      (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') &&
      Boolean(session.subscription);

    if (!complete) {
      // Ensure abandoned / open sessions cannot leave a Trial flag behind.
      await db.collection('users').doc(req.user.id).update({
        subscription_status: 'free',
        trial_ends_at: null,
        stripe_subscription_id: FieldValue.delete(),
        stripe_checkout_session_id: FieldValue.delete(),
        cancel_at_period_end: false,
        subscription_cancel_at: null,
        subscription_current_period_end: null,
        pending_plan: FieldValue.delete(),
        pending_plan_at: FieldValue.delete(),
        stripe_schedule_id: FieldValue.delete(),
        subscription_updated_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (session.status === 'open') {
        try {
          await stripe.checkout.sessions.expire(sessionId);
        } catch (err) {
          console.warn('[billing] expire on confirm failed', sessionId, err.message);
        }
      }
      const updated = enrichUserProfile(serializeDoc(await db.collection('users').doc(req.user.id).get()));
      const { password_hash: _ph, ...safeUser } = updated;
      return res.status(409).json({
        message: 'Checkout was not completed',
        user: safeUser,
      });
    }

    const subId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subId);
    const { applySubscriptionToUser } = require('./billingWebhook');
    await applySubscriptionToUser(req.user.id, subscription);

    await db.collection('users').doc(req.user.id).update({
      stripe_checkout_session_id: FieldValue.delete(),
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
      // Abandoned / fake Trial: no active Stripe subscription → force Free.
      const openSessionId = String(user.stripe_checkout_session_id || '').trim();
      if (openSessionId) {
        try {
          await stripe.checkout.sessions.expire(openSessionId);
        } catch (err) {
          console.warn('[billing] expire checkout session failed', openSessionId, err.message);
        }
      }

      const current = String(user.subscription_status || 'free').toLowerCase();
      if (current === 'free' && !user.stripe_subscription_id && !user.trial_ends_at) {
        const updated = enrichUserProfile(user);
        const { password_hash: _ph, ...safeUser } = updated;
        return res.json(safeUser);
      }

      await db.collection('users').doc(req.user.id).update({
        subscription_status: 'free',
        trial_ends_at: null,
        stripe_subscription_id: FieldValue.delete(),
        stripe_checkout_session_id: FieldValue.delete(),
        cancel_at_period_end: false,
        subscription_cancel_at: null,
        subscription_current_period_end: null,
        pending_plan: FieldValue.delete(),
        pending_plan_at: FieldValue.delete(),
        stripe_schedule_id: FieldValue.delete(),
        subscription_updated_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const updated = enrichUserProfile(serializeDoc(await db.collection('users').doc(req.user.id).get()));
      const { password_hash: _ph, ...safeUser } = updated;
      return res.json(safeUser);
    }

    const subscription = await stripe.subscriptions.retrieve(subId);
    const status = String(subscription.status || '');
    const planMeta = String(subscription.metadata?.plan || '').trim().toLowerCase();
    const pendingMeta = String(subscription.metadata?.pending_plan || '').trim().toLowerCase();
    const periodEndIso = stripeUnixToIso(subscriptionPeriodEndUnix(subscription));
    const interval = subscriptionIntervalOf(subscription);

    const patch = {
      stripe_subscription_id: subscription.id,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      cancel_at_period_end: subscription.cancel_at_period_end === true,
      subscription_cancel_at: subscription.cancel_at
        ? new Date(subscription.cancel_at * 1000).toISOString()
        : null,
      subscription_current_period_end: periodEndIso,
      subscription_interval: interval,
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

    if (planMeta === 'basis') {
      patch.pending_plan = FieldValue.delete();
      patch.pending_plan_at = FieldValue.delete();
      patch.stripe_schedule_id = FieldValue.delete();
    } else if (pendingMeta === 'basis') {
      patch.pending_plan = 'basis';
      patch.pending_plan_at = periodEndIso;
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
