const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');

// POST /api/auth/register
const register = async (req, res, next) => {
  try {
    const { email, password, country_settings, timezone } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email и пароль обязательны' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Пароль минимум 6 символов' });
    }

    const normalized = email.toLowerCase().trim();
    const existing = await db.collection('users').where('email', '==', normalized).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ message: 'Пользователь с таким email уже существует' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const docRef = await db.collection('users').add({
      email: normalized,
      password_hash,
      country_settings: country_settings || 'RU',
      tax_mode: 'none',
      timezone: timezone || 'Europe/Vienna',
      subscription_status: 'free',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const userSnap = await docRef.get();
    const user = serializeDoc(userSnap);

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

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
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email и пароль обязательны' });
    }

    const normalized = email.toLowerCase().trim();
    const snap = await db.collection('users').where('email', '==', normalized).limit(1).get();
    if (snap.empty) {
      return res.status(401).json({ message: 'Неверный email или пароль' });
    }

    const doc = snap.docs[0];
    const userData = doc.data();

    const isMatch = await bcrypt.compare(password, userData.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Неверный email или пароль' });
    }

    const token = jwt.sign({ id: doc.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

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
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/me
const me = async (req, res, next) => {
  try {
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }
    const raw = serializeDoc(doc);
    const { password_hash: _ph, ...safe } = raw;
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, me };
