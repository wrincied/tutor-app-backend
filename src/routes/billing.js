const express = require('express');
const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const billingAuth = [auth, requireVerifiedEmail];
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const {
  canPurchaseSubscription,
  enrichUserProfile,
  subscriptionLabel,
} = require('../utils/userProfile');
const {
  getSubscriptionPricing,
  getStripePriceIdForCountry,
} = require('../utils/subscriptionPricing');

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return null;
  }
  // eslint-disable-next-line global-require
  return require('stripe')(key);
}

async function loadUser(userId) {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) {
    return null;
  }
  return serializeDoc(snap);
}

/** POST /api/billing/checkout-session — Stripe Checkout (только при настроенном налоговом режиме). */
router.post('/checkout-session', billingAuth, async (req, res, next) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (!canPurchaseSubscription(user)) {
      return res.status(403).json({
        message:
          'Set your tax regime in Account before purchasing a subscription',
      });
    }

    const stripe = getStripe();
    const pricingCountry = user.country_settings;
    const pricing = getSubscriptionPricing(pricingCountry);
    const interval = req.body?.interval === 'yearly' ? 'yearly' : 'monthly';
    const priceId = getStripePriceIdForCountry(pricingCountry, interval);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';

    if (!stripe || !priceId) {
      return res.status(503).json({
        message:
          'Stripe is not configured (STRIPE_SECRET_KEY, STRIPE_PRICE_ID_PRO or STRIPE_PRICE_ID_PRO_XX)',
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/app/pricing?billing=success`,
      cancel_url: `${frontendUrl}/app/pricing?billing=cancel`,
      metadata: {
        userId: req.user.id,
        plan: 'pro',
        interval,
        pricingCountry,
        pricingCurrency: pricing.currency,
      },
    });

    res.json({ url: session.url, pricing });
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
