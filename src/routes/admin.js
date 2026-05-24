const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { enrichUserProfile, subscriptionLabel } = require('../utils/userProfile');
const { getSubscriptionPricing } = require('../utils/subscriptionPricing');

const TRIAL_GIFT_DAYS = 14;

router.use(auth, requireSuperAdmin);

router.get('/stats', async (req, res, next) => {
  try {
    const snap = await db.collection('users').get();
    let totalUsers = 0;
    let paidUsers = 0;
    let trialUsers = 0;
    const estimatedMrr = {};

    for (const doc of snap.docs) {
      totalUsers += 1;
      const data = doc.data();
      const status = subscriptionLabel(data.subscription_status);
      if (status === 'pro') {
        paidUsers += 1;
        const pricing = getSubscriptionPricing(data.country_settings);
        estimatedMrr[pricing.currency] = (estimatedMrr[pricing.currency] || 0) + pricing.monthly;
      } else if (status === 'trial') {
        trialUsers += 1;
      }
    }

    const conversionPercent =
      totalUsers > 0 ? Math.round((paidUsers / totalUsers) * 1000) / 10 : 0;

    res.json({
      totalUsers,
      paidUsers,
      trialUsers,
      conversionPercent,
      estimatedMrr,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    let snap;
    try {
      snap = await db.collection('users').orderBy('createdAt', 'desc').limit(500).get();
    } catch {
      snap = await db.collection('users').limit(500).get();
    }

    const users = snap.docs.map((doc) => {
      const raw = serializeDoc(doc);
      const enriched = enrichUserProfile(raw);
      return {
        _id: enriched._id,
        email: enriched.email || '',
        subscription_status: enriched.subscription_status,
        createdAt: raw.createdAt ?? null,
        role: enriched.role,
      };
    });

    res.json(users);
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/grant-trial', async (req, res, next) => {
  try {
    const userRef = db.collection('users').doc(req.params.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const trialEndsAt = new Date();
    trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + TRIAL_GIFT_DAYS);

    await userRef.update({
      subscription_status: 'trial',
      trial_ends_at: trialEndsAt,
      subscription_updated_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = enrichUserProfile(serializeDoc(await userRef.get()));
    res.json({
      ok: true,
      days: TRIAL_GIFT_DAYS,
      user: {
        _id: updated._id,
        email: updated.email,
        subscription_status: updated.subscription_status,
        trial_ends_at: updated.trial_ends_at ?? trialEndsAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
