const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const { generatePastelColor } = require('../utils/pastelColor');
const { normalizeBillingType, normalizeRateUnit, parseNonNegativeInt } = require('../utils/studentBilling');
const {
  collectPatchChanges,
  listActivityLogs,
  writeActivityLog,
} = require('../utils/activityLog');

const ALLOWED_CURRENCY = new Set(['BYN', 'PLN', 'EUR', 'USD', 'RUB', 'KZT', 'UAH']);

router.use(auth);
router.use(requireVerifiedEmail);

router.get('/activity-logs', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const limit = req.query.limit;
    const items = await listActivityLogs({ tutorId, category: 'students', limit });
    res.json(items);
  } catch (error) {
    next(error);
  }
});

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
      rate_unit,
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
    const rateUnit = normalizeRateUnit(rate_unit);
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
      rate_unit: rateUnit,
      credit_limit: initialCreditLimit,
      unpaid_lessons_count: 0,
      auto_debit_enabled: true,
      bot_active: false,
      timezone: timezone ? String(timezone) : 'Europe/Vienna',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const createdSnap = await createdRef.get();
    const created = serializeDoc(createdSnap);
    await writeActivityLog({
      tutorId,
      category: 'students',
      action: 'student.created',
      entityType: 'student',
      entityId: created._id,
      studentName: created.name,
      metadata: {
        rate_per_hour: created.rate_per_hour,
        rate_currency: created.rate_currency,
        balance_lessons: created.balance_lessons,
        timezone: created.timezone,
      },
    });
    res.status(201).json(created);
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
    const before = studentSnap.data();

    const {
      name,
      rate_per_hour,
      rate_currency,
      timezone,
      auto_debit_enabled,
      balance_lessons,
      billing_type,
      rate_unit,
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
    if (rate_unit !== undefined) {
      patch.rate_unit = normalizeRateUnit(rate_unit);
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
    const updated = serializeDoc(updatedSnap);
    const changes = collectPatchChanges(before, patch);
    if (changes.length) {
      await writeActivityLog({
        tutorId,
        category: 'students',
        action: 'student.updated',
        entityType: 'student',
        entityId: updated._id,
        studentName: updated.name,
        changes,
      });
    }
    res.json(updated);
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
    const deleted = studentSnap.data();
    await studentRef.delete();
    await writeActivityLog({
      tutorId,
      category: 'students',
      action: 'student.deleted',
      entityType: 'student',
      entityId: req.params.id,
      studentName: deleted.name ?? null,
    });
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
    const before = studentSnap.data();
    const rounded = Math.round(lessonsToAdd);

    await studentRef.update({
      balance_lessons: FieldValue.increment(rounded),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const updatedSnap = await studentRef.get();
    const updated = serializeDoc(updatedSnap);
    await writeActivityLog({
      tutorId,
      category: 'students',
      action: 'student.topup',
      entityType: 'student',
      entityId: updated._id,
      studentName: updated.name,
      changes: [
        {
          field: 'balance_lessons',
          from: Number(before.balance_lessons) || 0,
          to: Number(updated.balance_lessons) || 0,
        },
      ],
      metadata: { added: rounded },
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
