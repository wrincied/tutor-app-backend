const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const { generatePastelColor } = require('../utils/pastelColor');
const { normalizeBillingType, parseNonNegativeInt } = require('../utils/studentBilling');

const ALLOWED_CURRENCY = new Set(['BYN', 'PLN', 'EUR', 'USD', 'RUB']);

router.use(auth);
router.use(requireVerifiedEmail);

router.get('/', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const snap = await db.collection('students').where('tutor_id', '==', tutorId).get();
    const students = serializeQuerySnapshot(snap);
    const backfill = [];
    for (const student of students) {
      if (!student.color_hex) {
        const color_hex = generatePastelColor();
        student.color_hex = color_hex;
        backfill.push(
          db.collection('students').doc(student._id).update({
            color_hex,
            updatedAt: FieldValue.serverTimestamp(),
          }),
        );
      }
    }
    if (backfill.length) {
      await Promise.all(backfill);
    }
    students.sort((left, right) => {
      const l = left.createdAt ? Date.parse(left.createdAt) : 0;
      const r = right.createdAt ? Date.parse(right.createdAt) : 0;
      return r - l;
    });
    res.json(students);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const studentSnap = await db.collection('students').doc(req.params.id).get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }
    res.json(serializeDoc(studentSnap));
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const {
      name,
      rate_per_hour,
      rate_currency,
      timezone,
      color_hex,
      billing_type,
      balance_lessons,
      credit_limit,
    } = req.body;

    const normalizedName = name ? String(name).trim() : '';
    if (!normalizedName) {
      return res.status(400).json({ message: 'name is required' });
    }

    const ratePerHour = Number(rate_per_hour);
    if (Number.isNaN(ratePerHour) || ratePerHour < 0) {
      return res.status(400).json({ message: 'rate_per_hour must be a non-negative number' });
    }

    const currency = ALLOWED_CURRENCY.has(rate_currency) ? rate_currency : 'RUB';

    let studentColor = generatePastelColor();
    if (color_hex !== undefined) {
      const normalized = String(color_hex).trim();
      if (
        normalized.length <= 48 &&
        /^(#[0-9a-fA-F]{3,8}|hsl\([^)]+\)|rgb\([^)]+\))$/i.test(normalized)
      ) {
        studentColor = normalized;
      }
    }

    const billingType = normalizeBillingType(billing_type);
    const initialBalance =
      billingType === 'package' ? parseNonNegativeInt(balance_lessons, 0) : 0;
    const initialCreditLimit =
      billingType === 'postpaid' ? parseNonNegativeInt(credit_limit, 0) : 0;

    const createdRef = await db.collection('students').add({
      tutor_id: tutorId,
      name: normalizedName,
      rate_per_hour: ratePerHour,
      rate_currency: currency,
      color_hex: studentColor,
      balance_lessons: initialBalance,
      billing_type: billingType,
      credit_limit: initialCreditLimit,
      unpaid_lessons_count: 0,
      auto_debit_enabled: true,
      bot_active: false,
      timezone: timezone ? String(timezone) : 'Europe/Vienna',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const createdSnap = await createdRef.get();
    res.status(201).json(serializeDoc(createdSnap));
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const {
      name,
      rate_per_hour,
      rate_currency,
      timezone,
      auto_debit_enabled,
      balance_lessons,
      billing_type,
      credit_limit,
      color_hex,
      bot_active,
    } = req.body;
    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (name !== undefined) {
      patch.name = String(name).trim();
    }
    if (rate_per_hour !== undefined) {
      const ratePerHour = Number(rate_per_hour);
      if (Number.isNaN(ratePerHour) || ratePerHour < 0) {
        return res.status(400).json({ message: 'rate_per_hour must be a non-negative number' });
      }
      patch.rate_per_hour = ratePerHour;
    }
    if (rate_currency !== undefined && ALLOWED_CURRENCY.has(rate_currency)) {
      patch.rate_currency = rate_currency;
    }
    if (timezone !== undefined) {
      patch.timezone = String(timezone);
    }
    if (auto_debit_enabled !== undefined) {
      patch.auto_debit_enabled = Boolean(auto_debit_enabled);
    }
    if (billing_type !== undefined) {
      patch.billing_type = normalizeBillingType(billing_type);
    }
    if (balance_lessons !== undefined) {
      patch.balance_lessons = parseNonNegativeInt(balance_lessons, 0);
    }
    if (credit_limit !== undefined) {
      patch.credit_limit = parseNonNegativeInt(credit_limit, 0);
    }
    if (color_hex !== undefined) {
      const normalized = String(color_hex).trim();
      if (
        normalized.length > 48 ||
        !/^(#[0-9a-fA-F]{3,8}|hsl\([^)]+\)|rgb\([^)]+\))$/i.test(normalized)
      ) {
        return res.status(400).json({ message: 'Invalid color_hex' });
      }
      patch.color_hex = normalized;
    }
    if (bot_active !== undefined) {
      patch.bot_active = Boolean(bot_active);
    }

    await studentRef.update(patch);
    const updatedSnap = await studentRef.get();
    res.json(serializeDoc(updatedSnap));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }
    await studentRef.delete();
    res.json({ message: 'Deleted' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/topup', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const lessonsToAdd = Number(req.body.lessons);
    if (Number.isNaN(lessonsToAdd) || lessonsToAdd <= 0) {
      return res.status(400).json({ message: 'lessons must be a positive number' });
    }

    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }

    await studentRef.update({
      balance_lessons: FieldValue.increment(Math.round(lessonsToAdd)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const updatedSnap = await studentRef.get();
    res.json(serializeDoc(updatedSnap));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
