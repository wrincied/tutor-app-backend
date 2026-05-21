const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

const DEFAULT_TIMEZONE = 'Europe/Vienna';
const DEFAULT_COUNTRY = 'AT';

function makeToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, timezone, country_settings } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: 'password must be at least 6 characters' });
    }

    const existing = await db.collection('users').where('email', '==', normalizedEmail).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ message: 'User with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const createdRef = await db.collection('users').add({
      email: normalizedEmail,
      password_hash: passwordHash,
      country_settings: country_settings || DEFAULT_COUNTRY,
      tax_mode: 'none',
      timezone: timezone || DEFAULT_TIMEZONE,
      subscription_status: 'free',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const createdSnap = await createdRef.get();
    const user = serializeDoc(createdSnap);
    const token = makeToken(user._id);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        country_settings: user.country_settings,
        tax_mode: user.tax_mode,
        timezone: user.timezone,
        subscription_status: user.subscription_status,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const snap = await db.collection('users').where('email', '==', normalizedEmail).limit(1).get();
    if (snap.empty) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const doc = snap.docs[0];
    const userData = doc.data();
    const isValidPassword = await bcrypt.compare(password, userData.password_hash || '');
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = makeToken(doc.id);
    res.json({
      token,
      user: {
        id: doc.id,
        email: userData.email,
        country_settings: userData.country_settings,
        tax_mode: userData.tax_mode,
        timezone: userData.timezone,
        subscription_status: userData.subscription_status,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/me', auth, async (req, res, next) => {
  try {
    const userSnap = await db.collection('users').doc(req.user.id).get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }
    const user = enrichUserProfile(serializeDoc(userSnap));
    const { password_hash: _passwordHash, ...safeUser } = user;
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
    const {
      email,
      currentPassword,
      newPassword,
      country_settings,
      tax_mode,
      timezone,
    } = req.body;

    const needsPasswordCheck =
      (email && String(email).trim().toLowerCase() !== userData.email) ||
      (newPassword && String(newPassword).length > 0);

    if (needsPasswordCheck) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Current password is required' });
      }
      const valid = await bcrypt.compare(String(currentPassword), userData.password_hash || '');
      if (!valid) {
        return res.status(401).json({ message: 'Invalid current password' });
      }
    }

    const patch = { updatedAt: FieldValue.serverTimestamp() };

    if (email) {
      const normalized = String(email).trim().toLowerCase();
      const existing = await db.collection('users').where('email', '==', normalized).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== req.user.id) {
        return res.status(409).json({ message: 'User with this email already exists' });
      }
      patch.email = normalized;
    }

    if (newPassword) {
      if (String(newPassword).length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
      }
      patch.password_hash = await bcrypt.hash(String(newPassword), 10);
    }

    if (country_settings !== undefined) {
      patch.country_settings = String(country_settings);
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

    await userRef.update(patch);
    const updatedSnap = await userRef.get();
    const user = enrichUserProfile(serializeDoc(updatedSnap));
    const { password_hash: _ph, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
