const express = require('express');
const { db, FieldValue } = require('../firebase');
const { subscriptionLabel } = require('../utils/userProfile');

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return null;
  }
  // eslint-disable-next-line global-require
  return require('stripe')(key);
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

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = subscriptionLabel(session.metadata?.plan || 'pro');
      if (userId) {
        await db.collection('users').doc(userId).update({
          subscription_status: plan,
          subscription_updated_at: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
