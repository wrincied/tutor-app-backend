const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = express.Router();
const auth = require('../middleware/auth');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');

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
      tax_mode: 'austria-self-employed',
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
    const user = serializeDoc(userSnap);
    const { password_hash: _passwordHash, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
