const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const {
  enrichUserProfile,
  isTaxModeConfigured,
  assertConfigurableTaxMode,
  normalizeTaxMode,
} = require('../utils/userProfile');
const { DEFAULT_COUNTRY, normalizeCountryCode } = require('../utils/subscriptionPricing');
const {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKING_HOURS,
  normalizeWorkspace,
  normalizeWorkingHours,
} = require('../utils/userWorkspaceSettings');

const DEFAULT_TIMEZONE = 'Europe/Vienna';

async function ensureTutorUserDoc(req) {
  const uid = req.user.id;
  const email = String(req.user.email || '').trim().toLowerCase();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    await userRef.set({
      email,
      firebase_uid: uid,
      email_verified: req.user.email_verified,
      first_name: '',
      last_name: '',
      name: '',
      country_settings: DEFAULT_COUNTRY,
      tax_mode: 'none',
      timezone: DEFAULT_TIMEZONE,
      subscription_status: 'free',
      workspace: DEFAULT_WORKSPACE,
      workingHours: DEFAULT_WORKING_HOURS,
      role: 'tutor',
      onboarding_completed: false,
      data_consent_accepted: null,
      marketing_cookies_accepted: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } else {
    await userRef.update({
      email,
      email_verified: req.user.email_verified,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return userRef;
}

/** Создаёт или обновляет профиль репетитора в Firestore (документ id = Firebase UID). */
router.post('/bootstrap', auth, async (req, res, next) => {
  try {
    const userRef = await ensureTutorUserDoc(req);
    const updatedSnap = await userRef.get();
    const user = enrichUserProfile(serializeDoc(updatedSnap));
    const { password_hash: _ph, ...safeUser } = user;
    safeUser.email_verified = req.user.email_verified;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

router.get('/me', auth, async (req, res, next) => {
  try {
    const userRef = await ensureTutorUserDoc(req);
    const userSnap = await userRef.get();
    const user = enrichUserProfile(serializeDoc(userSnap));
    const { password_hash: _passwordHash, ...safeUser } = user;
    safeUser.email_verified = req.user.email_verified;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

router.put('/me', auth, async (req, res, next) => {
  try {
    const userRef = db.collection('users').doc(req.user.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = userSnap.data();
    const { name, first_name, last_name, tax_mode, timezone, workspace, workingHours } = req.body;

    const patch = { updatedAt: FieldValue.serverTimestamp() };

    if (first_name !== undefined || last_name !== undefined) {
      const first = String(first_name ?? userData.first_name ?? '').trim().slice(0, 60);
      const last = String(last_name ?? userData.last_name ?? '').trim().slice(0, 60);
      patch.first_name = first;
      patch.last_name = last;
      patch.name = `${first} ${last}`.trim().slice(0, 120);
    } else if (name !== undefined) {
      patch.name = String(name).trim().slice(0, 120);
    }
    if (tax_mode !== undefined) {
      const currentTax = normalizeTaxMode(userData.tax_mode);
      if (isTaxModeConfigured(currentTax)) {
        return res.status(403).json({
          message: 'Tax regime can only be set once and cannot be changed',
        });
      }
      const check = assertConfigurableTaxMode(tax_mode);
      if (!check.ok) {
        return res.status(400).json({ message: check.message });
      }
      patch.tax_mode = check.mode;
      patch.tax_mode_set_at = FieldValue.serverTimestamp();
    }
    if (timezone !== undefined) {
      patch.timezone = String(timezone);
    }
    if (workspace !== undefined) {
      patch.workspace = normalizeWorkspace(workspace);
    }
    if (workingHours !== undefined) {
      patch.workingHours = normalizeWorkingHours(workingHours);
    }

    await userRef.update(patch);
    const updatedSnap = await userRef.get();
    const user = enrichUserProfile(serializeDoc(updatedSnap));
    const { password_hash: _ph, ...safeUser } = user;
    safeUser.email_verified = req.user.email_verified;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

router.patch('/me/marketing-cookies', auth, async (req, res, next) => {
  try {
    const userRef = await ensureTutorUserDoc(req);
    const accepted = req.body?.accepted;
    if (typeof accepted !== 'boolean') {
      return res.status(400).json({ message: 'accepted must be a boolean' });
    }

    const now = FieldValue.serverTimestamp();
    await userRef.update({
      marketing_cookies_accepted: accepted,
      marketing_cookies_at: now,
      updatedAt: now,
    });

    const updatedSnap = await userRef.get();
    const user = enrichUserProfile(serializeDoc(updatedSnap));
    const { password_hash: _ph, ...safeUser } = user;
    safeUser.email_verified = req.user.email_verified;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

router.post('/onboarding', auth, async (req, res, next) => {
  try {
    const userRef = await ensureTutorUserDoc(req);

    const {
      first_name,
      last_name,
      country_settings,
      data_consent_accepted,
      marketing_cookies_accepted,
    } = req.body;

    if (!data_consent_accepted) {
      return res.status(400).json({ message: 'Data processing consent is required' });
    }

    const first = String(first_name ?? '').trim().slice(0, 60);
    const last = String(last_name ?? '').trim().slice(0, 60);
    if (!first) {
      return res.status(400).json({ message: 'First name is required' });
    }

    const country = normalizeCountryCode(country_settings);
    if (!country) {
      return res.status(400).json({ message: 'Unsupported country code' });
    }

    const now = FieldValue.serverTimestamp();
    await userRef.update({
      first_name: first,
      last_name: last,
      name: `${first} ${last}`.trim().slice(0, 120),
      country_settings: country,
      data_consent_accepted: true,
      data_consent_at: now,
      marketing_cookies_accepted: marketing_cookies_accepted === true,
      marketing_cookies_at: now,
      onboarding_completed: true,
      updatedAt: now,
    });

    const updatedSnap = await userRef.get();
    const user = enrichUserProfile(serializeDoc(updatedSnap));
    const { password_hash: _ph, ...safeUser } = user;
    safeUser.email_verified = req.user.email_verified;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

router.post('/onboarding/decline', auth, async (req, res, next) => {
  try {
    const userRef = await ensureTutorUserDoc(req);

    await userRef.update({
      data_consent_accepted: false,
      data_consent_at: FieldValue.serverTimestamp(),
      onboarding_completed: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
