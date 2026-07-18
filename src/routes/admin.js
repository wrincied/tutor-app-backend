const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { enrichUserProfile, subscriptionLabel } = require('../utils/userProfile');
const { getSubscriptionPricing } = require('../utils/subscriptionPricing');
const {
  buildAdminDashboard,
  DEFAULT_DASHBOARD_WIDGETS,
  normalizeDashboardWidgets,
} = require('../utils/adminDashboard');
const { listAllActivityLogs } = require('../utils/activityLog');
const { registerLandingAdminRoutes } = require('./adminLanding');
const { isSafeFirestoreId } = require('../utils/safeId');

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

function adminUserRow(doc, studentsCount) {
  const raw = serializeDoc(doc);
  const enriched = enrichUserProfile(raw);
  const row = {
    _id: enriched._id,
    email: enriched.email || '',
    subscription_status: enriched.subscription_status,
    trial_ends_at: raw.trial_ends_at ?? null,
    createdAt: raw.createdAt ?? null,
    last_login_at: raw.last_login_at ?? null,
    last_activity_at: raw.last_activity_at ?? null,
    email_verified: raw.email_verified === true,
    onboarding_completed: raw.onboarding_completed === true,
    country_settings: enriched.country_settings,
    role: enriched.role,
  };
  if (studentsCount !== undefined) {
    row.studentsCount = studentsCount;
  }
  return row;
}

async function buildStudentsCountByTutor(db) {
  const snap = await db.collection('students').get();
  const counts = new Map();
  snap.docs.forEach((doc) => {
    const tutorId = doc.data().tutor_id;
    if (!tutorId) {
      return;
    }
    counts.set(tutorId, (counts.get(tutorId) || 0) + 1);
  });
  return counts;
}

function sortByTimestampDesc(rows, field) {
  return [...rows].sort((left, right) => {
    const leftMs = left[field] ? Date.parse(left[field]) : 0;
    const rightMs = right[field] ? Date.parse(right[field]) : 0;
    return rightMs - leftMs;
  });
}

router.use(auth, requireSuperAdmin);

registerLandingAdminRoutes(router);

router.get('/dashboard', async (req, res, next) => {
  try {
    const payload = await buildAdminDashboard(db);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get('/preferences', async (req, res, next) => {
  try {
    const snap = await db.collection('users').doc(req.user.id).get();
    const widgets = normalizeDashboardWidgets(snap.data()?.admin_preferences?.dashboard_widgets);
    res.json({ dashboard_widgets: widgets });
  } catch (error) {
    next(error);
  }
});

router.put('/preferences', async (req, res, next) => {
  try {
    const widgets = normalizeDashboardWidgets(req.body?.dashboard_widgets);
    const userRef = db.collection('users').doc(req.user.id);
    await userRef.update({
      admin_preferences: { dashboard_widgets: widgets },
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, dashboard_widgets: widgets });
  } catch (error) {
    next(error);
  }
});

router.get('/users/:id/summary', async (req, res, next) => {
  try {
    if (!isSafeFirestoreId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user id', code: 'INVALID_ID' });
    }
    const userRef = db.collection('users').doc(req.params.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const tutorId = req.params.id;
    const [studentsSnap, lessonsSnap, activity] = await Promise.all([
      db.collection('students').where('tutor_id', '==', tutorId).get(),
      db.collection('lessons').where('tutor', '==', tutorId).get(),
      listAllActivityLogs({ tutorId, limit: 10 }),
    ]);

    res.json({
      user: adminUserRow(userSnap),
      studentsCount: studentsSnap.size,
      lessonsCount: lessonsSnap.size,
      recentActivity: activity,
    });
  } catch (error) {
    next(error);
  }
});

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

router.get('/recent-activity', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    let snap;
    try {
      snap = await db.collection('activity_logs').orderBy('createdAt', 'desc').limit(limit).get();
    } catch {
      snap = await db.collection('activity_logs').limit(500).get();
    }

    const usersSnap = await db.collection('users').get();
    const emailById = new Map();
    for (const doc of usersSnap.docs) {
      emailById.set(doc.id, String(doc.data().email || '').trim());
    }

    const items = snap.docs.map((doc) => {
      const raw = serializeDoc(doc);
      return {
        _id: raw._id,
        tutor_id: raw.tutor_id,
        user_email: emailById.get(raw.tutor_id) || raw.tutor_id || '',
        category: raw.category,
        action: raw.action,
        summary: raw.summary ?? '',
        student_name: raw.student_name ?? null,
        createdAt: raw.createdAt ?? null,
      };
    });

    res.json(sortByTimestampDesc(items, 'createdAt').slice(0, limit));
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

    const studentCounts = await buildStudentsCountByTutor(db);
    res.json(
      snap.docs.map((doc) => adminUserRow(doc, studentCounts.get(doc.id) ?? 0)),
    );
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/subscription', async (req, res, next) => {
  try {
    if (!isSafeFirestoreId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user id', code: 'INVALID_ID' });
    }
    // Only allow known fields (mass-assignment guard)
    const statusRaw = req.body?.subscription_status;
    const trialEndsAtRaw = req.body?.trial_ends_at;
    const userRef = db.collection('users').doc(req.params.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const built = buildSubscriptionPatch(statusRaw, trialEndsAtRaw);
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
    if (!isSafeFirestoreId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user id', code: 'INVALID_ID' });
    }
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
