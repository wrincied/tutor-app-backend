const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { enrichUserProfile, subscriptionLabel } = require('../utils/userProfile');
const { getSubscriptionPricing } = require('../utils/subscriptionPricing');

const TRIAL_GIFT_DAYS = 14;

function defaultTrialEndsAt(from = new Date()) {
  const ends = new Date(from);
  ends.setUTCDate(ends.getUTCDate() + TRIAL_GIFT_DAYS);
  ends.setUTCHours(23, 59, 59, 999);
  return ends;
}

function parseTrialEndsAt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T23:59:59.999Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildSubscriptionPatch(statusRaw, trialEndsAtRaw) {
  const status = subscriptionLabel(statusRaw);
  if (status !== 'free' && status !== 'pro' && status !== 'trial') {
    return { ok: false, message: 'subscription_status must be free, pro, or trial' };
  }

  const patch = {
    subscription_status: status,
    subscription_updated_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (status === 'trial') {
    const trialEndsAt = parseTrialEndsAt(trialEndsAtRaw) ?? defaultTrialEndsAt();
    patch.trial_ends_at = trialEndsAt;
  } else {
    patch.trial_ends_at = FieldValue.delete();
  }

  return { ok: true, patch };
}

function adminUserRow(doc) {
  const raw = serializeDoc(doc);
  const enriched = enrichUserProfile(raw);
  return {
    _id: enriched._id,
    email: enriched.email || '',
    subscription_status: enriched.subscription_status,
    trial_ends_at: raw.trial_ends_at ?? null,
    createdAt: raw.createdAt ?? null,
    role: enriched.role,
  };
}

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

    res.json(snap.docs.map((doc) => adminUserRow(doc)));
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/subscription', async (req, res, next) => {
  try {
    const userRef = db.collection('users').doc(req.params.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const built = buildSubscriptionPatch(req.body?.subscription_status, req.body?.trial_ends_at);
    if (!built.ok) {
      return res.status(400).json({ message: built.message });
    }

    await userRef.update(built.patch);
    const updated = adminUserRow(await userRef.get());
    res.json({ ok: true, user: updated });
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

    const built = buildSubscriptionPatch('trial', req.body?.trial_ends_at);
    await userRef.update(built.patch);

    const updated = adminUserRow(await userRef.get());
    res.json({
      ok: true,
      days: TRIAL_GIFT_DAYS,
      user: updated,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
