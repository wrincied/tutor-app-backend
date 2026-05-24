const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const {
  enrichLessonSnapshot,
  lessonIncomeFromSnapshot,
  lessonScheduledRevenueFromSnapshot,
  normalizeLessonStatus,
} = require('../utils/lessonSnapshot');
const {
  convertAmount,
  getExchangeRates,
  normalizeCurrency,
  ratesForReport,
} = require('../utils/currencyConvert');
const { computeAustriaSelfEmployedProjection } = require('../utils/financeTax');
const { collectPatchChanges, listActivityLogs, writeActivityLog } = require('../utils/activityLog');

const COUNTRY_CURRENCY = {
  AT: 'EUR',
  DE: 'EUR',
  PL: 'PLN',
  RU: 'RUB',
  BY: 'BYN',
  KZ: 'KZT',
  US: 'USD',
};

function parseDateQuery(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const d = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function lessonDate(lessonData) {
  const raw = lessonData.scheduledAt || lessonData.createdAt;
  if (!raw) {
    return null;
  }
  if (raw && typeof raw.toDate === 'function') {
    return raw.toDate();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function expenseDate(expenseData) {
  const raw = expenseData.expense_date || expenseData.createdAt;
  if (!raw) {
    return null;
  }
  if (raw && typeof raw.toDate === 'function') {
    return raw.toDate();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inPeriod(date, from, to) {
  if (!date) {
    return true;
  }
  if (from && date < from) {
    return false;
  }
  if (to) {
    const end = new Date(to);
    end.setUTCHours(23, 59, 59, 999);
    if (date > end) {
      return false;
    }
  }
  return true;
}

function addIncomeByCurrency(bucket, currency, amount) {
  const code = currency && String(currency).trim() ? String(currency).trim().toUpperCase() : 'EUR';
  bucket[code] = (bucket[code] ?? 0) + amount;
}

router.use(auth);
router.use(requireVerifiedEmail);

router.get('/activity-logs', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const limit = req.query.limit;
    const items = await listActivityLogs({ tutorId, category: 'finance', limit });
    res.json(items);
  } catch (error) {
    next(error);
  }
});

router.get('/expenses', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const snap = await db.collection('expenses').where('tutor', '==', tutorId).get();
    const items = serializeQuerySnapshot(snap);
    items.sort((a, b) => {
      const da = expenseDate(a)?.getTime() ?? 0;
      const db_ = expenseDate(b)?.getTime() ?? 0;
      return db_ - da;
    });
    res.json(items);
  } catch (error) {
    next(error);
  }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const title = req.body.title ? String(req.body.title).trim() : '';
    const amount = Number(req.body.amount);
    if (!title) {
      return res.status(400).json({ message: 'title is required' });
    }
    if (Number.isNaN(amount) || amount < 0) {
      return res.status(400).json({ message: 'amount must be a non-negative number' });
    }

    let expenseDateIso = new Date().toISOString().slice(0, 10);
    if (req.body.expense_date) {
      const parsed = parseDateQuery(String(req.body.expense_date).slice(0, 10));
      if (!parsed) {
        return res.status(400).json({ message: 'expense_date must be YYYY-MM-DD' });
      }
      expenseDateIso = parsed.toISOString().slice(0, 10);
    }

    const category =
      req.body.category !== undefined && req.body.category !== null
        ? String(req.body.category).trim().slice(0, 64)
        : '';

    const doc = {
      tutor: tutorId,
      title,
      amount,
      expense_date: expenseDateIso,
      category,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('expenses').add(doc);
    const created = await ref.get();
    const expense = serializeDoc(created);
    await writeActivityLog({
      tutorId,
      category: 'finance',
      action: 'expense.created',
      entityType: 'expense',
      entityId: expense._id,
      metadata: {
        title: expense.title,
        amount: expense.amount,
        expense_date: expense.expense_date,
        category: expense.category ?? '',
      },
    });
    res.status(201).json(expense);
  } catch (error) {
    next(error);
  }
});

router.put('/expenses/:id', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const ref = db.collection('expenses').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().tutor !== tutorId) {
      return res.status(404).json({ message: 'Expense not found' });
    }
    const before = snap.data();

    const patch = { updatedAt: FieldValue.serverTimestamp() };

    if (req.body.title !== undefined) {
      const title = String(req.body.title).trim();
      if (!title) {
        return res.status(400).json({ message: 'title cannot be empty' });
      }
      patch.title = title;
    }

    if (req.body.amount !== undefined) {
      const amount = Number(req.body.amount);
      if (Number.isNaN(amount) || amount < 0) {
        return res.status(400).json({ message: 'amount must be a non-negative number' });
      }
      patch.amount = amount;
    }

    if (req.body.expense_date !== undefined) {
      const parsed = parseDateQuery(String(req.body.expense_date).slice(0, 10));
      if (!parsed) {
        return res.status(400).json({ message: 'expense_date must be YYYY-MM-DD' });
      }
      patch.expense_date = parsed.toISOString().slice(0, 10);
    }

    if (req.body.category !== undefined) {
      patch.category =
        req.body.category === null ? '' : String(req.body.category).trim().slice(0, 64);
    }

    await ref.update(patch);
    const updated = await ref.get();
    const expense = serializeDoc(updated);
    const expenseFields = ['title', 'amount', 'expense_date', 'category'];
    const changes = collectPatchChanges(before, patch, expenseFields);
    if (changes.length) {
      await writeActivityLog({
        tutorId,
        category: 'finance',
        action: 'expense.updated',
        entityType: 'expense',
        entityId: expense._id,
        changes,
        metadata: { title: expense.title },
      });
    }
    res.json(expense);
  } catch (error) {
    next(error);
  }
});

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const ref = db.collection('expenses').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().tutor !== tutorId) {
      return res.status(404).json({ message: 'Expense not found' });
    }
    const deleted = snap.data();
    await ref.delete();
    await writeActivityLog({
      tutorId,
      category: 'finance',
      action: 'expense.deleted',
      entityType: 'expense',
      entityId: req.params.id,
      metadata: {
        title: deleted.title,
        amount: deleted.amount,
        expense_date: deleted.expense_date,
      },
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const from = parseDateQuery(req.query.from);
    const to = parseDateQuery(req.query.to);

    const [lessonsSnap, expensesSnap, userSnap, studentsSnap] = await Promise.all([
      db.collection('lessons').where('tutor', '==', tutorId).get(),
      db.collection('expenses').where('tutor', '==', tutorId).get(),
      db.collection('users').doc(tutorId).get(),
      db.collection('students').where('tutor_id', '==', tutorId).get(),
    ]);

    const studentById = new Map();
    studentsSnap.forEach((doc) => {
      const row = serializeDoc(doc);
      studentById.set(row._id, row);
    });
    const lessons = serializeQuerySnapshot(lessonsSnap).map((lesson) =>
      enrichLessonSnapshot(lesson, studentById),
    );

    const userData = userSnap.exists ? userSnap.data() : {};
    const country = String(userData.country_settings ?? 'AT').toUpperCase();
    const taxMode = String(userData.tax_mode ?? 'none');
    const defaultCurrency = COUNTRY_CURRENCY[country] ?? 'EUR';
    const reportCurrency =
      req.query.currency && typeof req.query.currency === 'string'
        ? normalizeCurrency(req.query.currency)
        : defaultCurrency;
    const { rates: eurRates, date: ratesDate, source: ratesSource } = await getExchangeRates();
    const exchangeRatesMeta = {
      base: 'EUR',
      reportCurrency,
      asOf: ratesDate,
      source: ratesSource,
      rates: ratesForReport(eurRates),
    };

    let totalIncome = 0;
    let scheduledIncome = 0;
    let lessonCount = 0;
    let scheduledLessonCount = 0;
    let completedLessonCount = 0;
    let missedLessonCount = 0;
    let canceledLessonCount = 0;
    let totalLessonHours = 0;
    let completedLessonHours = 0;
    let scheduledLessonHours = 0;
    const incomeByCurrency = {};
    const scheduledByCurrency = {};

    for (const data of lessons) {
      if (!inPeriod(lessonDate(data), from, to)) {
        continue;
      }
      const status = normalizeLessonStatus(data.status);
      lessonCount += 1;
      const durationMinutes = Number(data.lesson_duration ?? 60);
      const hours =
        !Number.isNaN(durationMinutes) && durationMinutes > 0 ? durationMinutes / 60 : 0;

      if (status === 'scheduled') {
        scheduledLessonCount += 1;
        scheduledLessonHours += hours;
      } else if (status === 'completed') {
        completedLessonCount += 1;
        completedLessonHours += hours;
      } else if (status === 'missed') {
        missedLessonCount += 1;
      } else if (status === 'canceled') {
        canceledLessonCount += 1;
      }

      totalLessonHours += hours;

      const earned = lessonIncomeFromSnapshot(data);
      const planned = lessonScheduledRevenueFromSnapshot(data);
      const lessonCurrency = normalizeCurrency(data.lesson_currency);
      const earnedReport = convertAmount(earned, lessonCurrency, reportCurrency, eurRates);
      const plannedReport = convertAmount(planned, lessonCurrency, reportCurrency, eurRates);
      totalIncome += earnedReport;
      scheduledIncome += plannedReport;

      if (earned > 0) {
        addIncomeByCurrency(incomeByCurrency, lessonCurrency, earned);
      }
      if (planned > 0) {
        addIncomeByCurrency(scheduledByCurrency, lessonCurrency, planned);
      }
    }

    let totalExpenses = 0;
    let expenseCount = 0;
    expensesSnap.forEach((doc) => {
      const data = doc.data();
      if (!inPeriod(expenseDate(data), from, to)) {
        return;
      }
      expenseCount += 1;
      const amount = Number(data.amount);
      const raw = Number.isNaN(amount) ? 0 : amount;
      totalExpenses += convertAmount(raw, defaultCurrency, reportCurrency, eurRates);
    });

    const combinedIncome = totalIncome + scheduledIncome;
    const combinedByCurrency = {};
    for (const code of new Set([
      ...Object.keys(incomeByCurrency),
      ...Object.keys(scheduledByCurrency),
    ])) {
      const raw =
        (incomeByCurrency[code] ?? 0) + (scheduledByCurrency[code] ?? 0);
      combinedByCurrency[code] = convertAmount(raw, code, reportCurrency, eurRates);
    }

    const grossProfit = totalIncome - totalExpenses;
    const austriaProjection = computeAustriaSelfEmployedProjection(grossProfit);

    res.json({
      currency: reportCurrency,
      defaultCurrency,
      country,
      tax_mode: taxMode,
      period: {
        from: from ? from.toISOString().slice(0, 10) : null,
        to: to ? to.toISOString().slice(0, 10) : null,
      },
      exchangeRates: exchangeRatesMeta,
      totals: {
        lessonCount,
        scheduledLessonCount,
        completedLessonCount,
        missedLessonCount,
        canceledLessonCount,
        totalLessonHours,
        completedLessonHours,
        scheduledLessonHours,
        expenseCount,
      },
      income: {
        totalIncome,
        scheduledIncome,
        combinedIncome,
        totalExpenses,
        grossProfit,
        byCurrency: incomeByCurrency,
        scheduledByCurrency,
        combinedByCurrency,
      },
      austria: taxMode === 'at-self-employed' ? austriaProjection : null,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
