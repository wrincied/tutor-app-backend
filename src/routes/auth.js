const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const {
  enrichUserProfile,
  assertConfigurableTaxMode,
  normalizeTaxMode,
} = require('../utils/userProfile');
const { DEFAULT_COUNTRY, normalizeCountryCode, countryFromTaxMode } = require('../utils/subscriptionPricing');
const {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKING_HOURS,
  DEFAULT_VACATION,
  normalizeWorkspace,
  normalizeWorkingHours,
  normalizeVacation,
} = require('../utils/userWorkspaceSettings');
const { sendPasswordResetForEmail } = require('../services/passwordResetService');
const { sendVerificationEmailForAddress } = require('../services/emailVerificationMail');
const { passwordResetLimiter, verificationMailLimiter } = require('../middleware/rateLimit');
const {
  allocateReferralCode,
  attachReferral,
  referralCodeFromRequest,
} = require('../utils/referralAttribution');

const DEFAULT_TIMEZONE = 'Europe/Vienna';
const TIMEZONE_RE = /^[A-Za-z0-9_+\-\/]{1,80}$/;
const limitPasswordReset = passwordResetLimiter();
const limitVerificationMail = verificationMailLimiter();

/**
 * Гарантирует документ users/{uid}. Пишет в Firestore только при создании
 * или реальном изменении email / email_verified (не на каждый /me).
 * @returns {{ userRef: FirebaseFirestore.DocumentReference, userSnap: FirebaseFirestore.DocumentSnapshot }}
 */
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
      vacation: DEFAULT_VACATION,
      role: 'tutor',
      onboarding_completed: false,
      data_consent_accepted: null,
      marketing_cookies_accepted: null,
      isEarlyAdopter: false,
      referredBy: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { userRef, userSnap: await userRef.get(), created: true };
  }

  const data = userSnap.data() || {};
  const patch = {};
  const currentEmail = String(data.email || '').trim().toLowerCase();
  if (email && email !== currentEmail) {
    patch.email = email;
  }
  if (Boolean(req.user.email_verified) !== Boolean(data.email_verified)) {
    patch.email_verified = req.user.email_verified;
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = FieldValue.serverTimestamp();
    await userRef.update(patch);
    return { userRef, userSnap: await userRef.get(), created: false };
  }

  return { userRef, userSnap, created: false };
}

async function syncReferralFields(req, userRef, userSnap, created) {
  await allocateReferralCode(db, FieldValue, userRef, userSnap.data()?.referralCode);
  const code = referralCodeFromRequest(req);
  if (created && code) {
    await attachReferral({ db, FieldValue, refereeUid: req.user.id, code });
  }
  return userRef.get();
}

/** Public: password reset email with Simple4U /auth/action link (bypasses Firebase Console action URL). */
router.post('/password-reset', limitPasswordReset, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const result = await sendPasswordResetForEmail(email);
    if (!result.ok && result.reason === 'invalid_email') {
      return res.status(400).json({ error: 'Invalid email' });
    }
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** Auth: send email-verification link via Resend (SPA /auth/action). */
router.post('/send-verification-email', auth, limitVerificationMail, async (req, res, next) => {
  try {
    if (req.user.email_verified) {
      return res.json({ ok: true, alreadyVerified: true });
    }
    const email = String(req.user.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const result = await sendVerificationEmailForAddress(email);
    if (!result.ok) {
      if (result.reason === 'user_not_found') {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.status(400).json({ error: 'Could not send verification email' });
    }
    return res.json({ ok: true, alreadyVerified: Boolean(result.alreadyVerified) });
  } catch (error) {
    next(error);
  }
});

/** Фиксирует визит пользователя (last_login_at). Вызывается с фронта при входе в /app. */
router.post('/presence', auth, async (req, res, next) => {
  try {
    const { userRef } = await ensureTutorUserDoc(req);
    const now = FieldValue.serverTimestamp();
    await userRef.update({
      last_login_at: now,
      updatedAt: now,
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** Создаёт или обновляет профиль репетитора в Firestore (документ id = Firebase UID). */
router.post('/bootstrap', auth, async (req, res, next) => {
  try {
    const { userRef, userSnap, created } = await ensureTutorUserDoc(req);
    const fresh = await syncReferralFields(req, userRef, userSnap, created);
    const user = enrichUserProfile(serializeDoc(fresh));
    const { password_hash: _ph, ...safeUser } = user;
    safeUser.email_verified = req.user.email_verified;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

router.get('/me', auth, async (req, res, next) => {
  try {
    const { userRef, userSnap, created } = await ensureTutorUserDoc(req);
    const fresh = await syncReferralFields(req, userRef, userSnap, created);
    const user = enrichUserProfile(serializeDoc(fresh));
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
    const { name, first_name, last_name, tax_mode, timezone, workspace, workingHours, vacation } =
      req.body;

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
      const check = assertConfigurableTaxMode(tax_mode);
      if (!check.ok) {
        return res.status(400).json({ message: check.message });
      }
      const currentTax = normalizeTaxMode(userData.tax_mode);
      if (check.mode !== currentTax) {
        patch.tax_mode = check.mode;
        patch.tax_mode_set_at = FieldValue.serverTimestamp();
        const pricingCountry = countryFromTaxMode(check.mode);
        if (pricingCountry) {
          patch.country_settings = pricingCountry;
        }
      }
    }
    if (timezone !== undefined) {
      const tz = String(timezone).trim().slice(0, 80);
      if (!TIMEZONE_RE.test(tz)) {
        return res.status(400).json({ message: 'Invalid timezone' });
      }
      patch.timezone = tz;
    }
    if (workspace !== undefined) {
      patch.workspace = normalizeWorkspace(workspace);
    }
    if (workingHours !== undefined) {
      patch.workingHours = normalizeWorkingHours(workingHours);
    }
    if (vacation !== undefined) {
      patch.vacation = normalizeVacation(vacation);
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
    const { userRef } = await ensureTutorUserDoc(req);
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
    const { userRef } = await ensureTutorUserDoc(req);

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
    const { userRef } = await ensureTutorUserDoc(req);

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
