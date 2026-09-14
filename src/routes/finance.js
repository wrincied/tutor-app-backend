const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const {
  enrichLessonSnapshot,
  lessonIncomeForStatus,
  lessonScheduledRevenueForStatus,
  normalizeLessonStatus,
} = require('../utils/lessonSnapshot');
const {
  convertAmount,
  getExchangeRates,
  normalizeCurrency,
  ratesForReport,
  FALLBACK_EUR_RATES,
} = require('../utils/currencyConvert');
const { computeTaxProjection } = require('../utils/financeTax');
const { normalizeTaxMode, hasFinanceAccess, subscriptionLabel } = require('../utils/userProfile');
const { collectPatchChanges, listActivityLogs, writeActivityLog } = require('../utils/activityLog');
const {
  classifyFinanceOrphan,
  expandFinanceOccurrences,
  financeOccurrenceRange,
} = require('../utils/lessonRecurrence');
const { selectUnpaidLessonsForSettlement } = require('../utils/topupSettle');
const { normalizeRateUnit } = require('../utils/studentBilling');

async function loadTutorSubscriptionStatus(tutorId) {
  const snap = await db.collection('users').doc(String(tutorId)).get();
  if (!snap.exists) {
    return 'free';
  }
  return subscriptionLabel(snap.data()?.subscription_status);
}

async function requireFinancePlan(req, res, next) {
  try {
    const status = await loadTutorSubscriptionStatus(req.user.id);
    if (!hasFinanceAccess(status)) {
      return res.status(403).json({
        code: 'PLAN_FINANCE_REQUIRED',
        message: 'Finance module requires Basis or Pro',
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

const COUNTRY_CURRENCY = {
  AT: 'EUR',
  DE: 'EUR',
  PL: 'PLN',
  RU: 'RUB',
  BY: 'BYN',
  KZ: 'KZT',
  US: 'USD',
  UA: 'UAH',
};

function defaultCurrencyForUser(userData) {
  const country = String(userData?.country_settings ?? 'AT').toUpperCase();
  return COUNTRY_CURRENCY[country] ?? 'EUR';
}

function expenseStoredCurrency(data, accountDefaultCurrency) {
  return normalizeCurrency(data?.currency ?? accountDefaultCurrency);
}

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

/**
 * Summary с from/to: не грузим всю историю уроков.
 * Берём recurring-серии + one-off в окне дат (±1 день из‑за TZ).
 * При отсутствии индекса — fallback на полный scan.
 */
async function fetchLessonsSnapForSummary(tutorId, { from, to }) {
  if (!from || !to) {
    return db.collection('lessons').where('tutor', '==', tutorId).get();
  }

  try {
    const rangeStart = new Date(from);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - 1);
    const rangeEnd = new Date(to);
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 2);
    rangeEnd.setUTCHours(0, 0, 0, 0);

    const fromIso = rangeStart.toISOString();
    const toIso = rangeEnd.toISOString();

    const [recurringSnap, rangedSnap] = await Promise.all([
      db.collection('lessons').where('tutor', '==', tutorId).where('isRecurring', '==', true).get(),
      db
        .collection('lessons')
        .where('tutor', '==', tutorId)
        .where('scheduledAt', '>=', fromIso)
        .where('scheduledAt', '<', toIso)
        .get(),
    ]);

    const byId = new Map();
    for (const doc of recurringSnap.docs) {
      byId.set(doc.id, doc);
    }
    for (const doc of rangedSnap.docs) {
      byId.set(doc.id, doc);
    }

    return {
      docs: [...byId.values()],
      empty: byId.size === 0,
      size: byId.size,
      forEach(cb) {
        byId.forEach((doc) => cb(doc));
      },
    };
  } catch (err) {
    console.warn(
      '[finance/summary] narrow lessons query failed, fallback full scan:',
      err?.message || err,
    );
    return db.collection('lessons').where('tutor', '==', tutorId).get();
  }
}

function parseStoredDate(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw.toDate === 'function') {
    return raw.toDate();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function lessonDateIsoFromKey(occurrenceDate, scheduledAt) {
  if (occurrenceDate && /^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
    return occurrenceDate;
  }
  if (!scheduledAt) {
    return null;
  }
  const d = new Date(scheduledAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Полный ISO datetime для UI (home/agenda). Не обрезать до даты — иначе 00:00Z → 02:00 локально. */
function lessonScheduledAtIso(occurrenceScheduledAt, fallbackScheduledAt) {
  const raw = occurrenceScheduledAt || fallbackScheduledAt;
  if (!raw) {
    return null;
  }
  if (typeof raw === 'string' && raw.includes('T')) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
    return !from && !to;
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

router.post('/report-export', requireFinancePlan, async (req, res, next) => {
  try {
    const kindRaw = String(req.body?.kind || 'pdf').trim().toLowerCase();
    const kind = kindRaw === 'excel' || kindRaw === 'csv' ? kindRaw : 'pdf';
    await writeActivityLog({
      tutorId: req.user.id,
      category: 'finance',
      action: 'finance.export',
      entityType: 'report',
      metadata: { kind },
    });
    res.json({ ok: true, kind });
  } catch (error) {
    next(error);
  }
});

router.get('/activity-logs', requireFinancePlan, async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const limit = req.query.limit;
    const items = await listActivityLogs({ tutorId, category: 'finance', limit });
    res.json(items);
  } catch (error) {
    next(error);
  }
});

router.get('/expenses', requireFinancePlan, async (req, res, next) => {
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

router.post('/expenses', requireFinancePlan, async (req, res, next) => {
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

    const userSnap = await db.collection('users').doc(tutorId).get();
    const accountDefaultCurrency = defaultCurrencyForUser(userSnap.exists ? userSnap.data() : {});
    const currency = normalizeCurrency(req.body.currency ?? accountDefaultCurrency);

    const doc = {
      tutor: tutorId,
      title,
      amount,
      currency,
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
        currency: expense.currency ?? currency,
        expense_date: expense.expense_date,
        category: expense.category ?? '',
      },
    });
    res.status(201).json(expense);
  } catch (error) {
    next(error);
  }
});

router.put('/expenses/:id', requireFinancePlan, async (req, res, next) => {
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

    if (req.body.currency !== undefined) {
      patch.currency = normalizeCurrency(req.body.currency);
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
    const expenseFields = ['title', 'amount', 'currency', 'expense_date', 'category'];
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

router.delete('/expenses/:id', requireFinancePlan, async (req, res, next) => {
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
    const homeScope = String(req.query.scope || '').toLowerCase() === 'home';
    if (!homeScope) {
      const status = await loadTutorSubscriptionStatus(req.user.id);
      if (!hasFinanceAccess(status)) {
        return res.status(403).json({
          code: 'PLAN_FINANCE_REQUIRED',
          message: 'Finance module requires Basis or Pro',
        });
      }
    }

    const tutorId = req.user.id;
    const from = parseDateQuery(req.query.from);
    const to = parseDateQuery(req.query.to);

    // Курсы стартуют параллельно с Firestore (кэш ~1ч — почти мгновенно).
    // Home: не ждём ЦБ — иначе summary упирается в timeout ~12s при недоступном банке.
    const ratesPromise = homeScope ? null : getExchangeRates();
    const lessonsStarted = Date.now();
    console.log('[finance/summary] start', {
      homeScope,
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
      tutorId,
    });

    const [lessonsSnap, expensesSnap, userSnap, studentsSnap] = await Promise.all([
      fetchLessonsSnapForSummary(tutorId, { from, to }),
      homeScope
        ? Promise.resolve({ forEach() {}, empty: true, size: 0 })
        : db.collection('expenses').where('tutor', '==', tutorId).get(),
      db.collection('users').doc(tutorId).get(),
      db.collection('students').where('tutor_id', '==', tutorId).get(),
    ]);

    if (from && to) {
      console.log('[finance/summary] lessons loaded', {
        homeScope,
        count: lessonsSnap.size,
        ms: Date.now() - lessonsStarted,
      });
    }

    const studentById = new Map();
    const studentsHome = [];
    studentsSnap.forEach((doc) => {
      const row = serializeDoc(doc);
      studentById.set(row._id, row);
      if (homeScope) {
        studentsHome.push({
          _id: row._id,
          name: row.name ?? '',
          color_hex: row.color_hex ?? null,
          balance_lessons: Number(row.balance_lessons) || 0,
          billing_type: row.billing_type ?? 'package',
          rate_unit: row.rate_unit ?? 'hour',
        });
      }
    });
    const lessons = serializeQuerySnapshot(lessonsSnap).map((lesson) =>
      enrichLessonSnapshot(lesson, studentById),
    );

    const userData = userSnap.exists ? userSnap.data() : {};
    const country = String(userData.country_settings ?? 'AT').toUpperCase();
    const taxMode = normalizeTaxMode(userData.tax_mode);
    const defaultCurrency = defaultCurrencyForUser(userData);
    const reportCurrency =
      req.query.currency && typeof req.query.currency === 'string'
        ? normalizeCurrency(req.query.currency)
        : defaultCurrency;

    const usedCurrencies = new Set([reportCurrency]);
    for (const lesson of lessons) {
      usedCurrencies.add(normalizeCurrency(lesson.lesson_currency));
    }
    if (!homeScope) {
      expensesSnap.forEach((doc) => {
        usedCurrencies.add(expenseStoredCurrency(doc.data(), defaultCurrency));
      });
    }
    const needsFx = !homeScope && [...usedCurrencies].some((code) => code !== reportCurrency);

    const { rates: eurRates, date: ratesDate, source: ratesSource } = needsFx
      ? await ratesPromise
      : {
          rates: FALLBACK_EUR_RATES,
          date: new Date().toISOString().slice(0, 10),
          source: homeScope ? 'home-fallback' : 'same-currency',
        };
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
    const lessonsBreakdown = [];
    const { start: occurrenceRangeStart, end: occurrenceRangeEnd } = financeOccurrenceRange(from, to);

    const unpaidLessonIds = new Set();
    const lessonsByStudent = new Map();
    for (const data of lessons) {
      if (!data.student_id) {
        continue;
      }
      const list = lessonsByStudent.get(data.student_id) || [];
      list.push(data);
      lessonsByStudent.set(data.student_id, list);
    }
    for (const [studentId, studentLessons] of lessonsByStudent) {
      const student = studentById.get(studentId);
      if (!student) {
        continue;
      }
      for (const unpaid of selectUnpaidLessonsForSettlement(
        studentLessons,
        student,
        normalizeRateUnit(student.rate_unit),
      )) {
        unpaidLessonIds.add(unpaid._id || unpaid.id);
      }
    }

    for (const data of lessons) {
      const student = data.student_id ? studentById.get(data.student_id) : null;
      const lessonCurrency = normalizeCurrency(data.lesson_currency);
      const orphanReason = classifyFinanceOrphan(data);
      const paymentUnpaid = unpaidLessonIds.has(data._id);

      if (orphanReason) {
        const durationMinutes = Number(data.lesson_duration ?? 60);
        lessonsBreakdown.push({
          id: data._id,
          studentId: data.student_id ?? null,
          studentName: student?.name ? String(student.name) : null,
          scheduledAt: null,
          occurrenceDate: null,
          status: normalizeLessonStatus(data.status),
          durationMinutes:
            !Number.isNaN(durationMinutes) && durationMinutes > 0 ? durationMinutes : 60,
          amountReport: 0,
          amountOriginal: 0,
          currency: lessonCurrency,
          visibleInCalendar: false,
          isRecurring: data.isRecurring === true || Boolean(data.rrule),
          incomeType: 'none',
          hiddenReason: orphanReason,
          paymentUnpaid: false,
        });
        continue;
      }

      const occurrences = expandFinanceOccurrences(data, occurrenceRangeStart, occurrenceRangeEnd);
      for (const occurrence of occurrences) {
        const status = normalizeLessonStatus(occurrence.status);
        lessonCount += 1;
        const hours = occurrence.durationMinutes / 60;

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

        const earned = lessonIncomeForStatus(data, status);
        const planned = lessonScheduledRevenueForStatus(data, status);
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

        const rawRevenue = earned > 0 ? earned : planned;
        lessonsBreakdown.push({
          id: occurrence.isRecurring ? `${data._id}:${occurrence.occurrenceDate}` : data._id,
          lessonId: data._id,
          studentId: data.student_id ?? null,
          studentName: student?.name ? String(student.name) : null,
          scheduledAt: lessonScheduledAtIso(occurrence.scheduledAt, data.scheduledAt),
          occurrenceDate:
            occurrence.occurrenceDate ||
            lessonDateIsoFromKey(null, occurrence.scheduledAt || data.scheduledAt),
          status,
          durationMinutes: occurrence.durationMinutes,
          amountReport: earnedReport + plannedReport,
          amountOriginal: rawRevenue,
          currency: lessonCurrency,
          visibleInCalendar: occurrence.visibleInCalendar,
          isRecurring: occurrence.isRecurring,
          incomeType: earned > 0 ? 'completed' : planned > 0 ? 'scheduled' : 'none',
          hiddenReason: null,
          scheduleDerived: Boolean(occurrence.scheduleDerived),
          paymentUnpaid: paymentUnpaid && status !== 'scheduled',
        });
      }
    }

    lessonsBreakdown.sort((left, right) => {
      const l = left.scheduledAt ?? '';
      const r = right.scheduledAt ?? '';
      return r.localeCompare(l);
    });

    let totalExpenses = 0;
    let expenseCount = 0;
    const expensesBreakdown = [];
    if (!homeScope) {
      expensesSnap.forEach((doc) => {
        const data = doc.data();
        const expDate = expenseDate(data);
        if (!inPeriod(expDate, from, to)) {
          return;
        }
        expenseCount += 1;
        const amount = Number(data.amount);
        const raw = Number.isNaN(amount) ? 0 : amount;
        const expenseCurrency = expenseStoredCurrency(data, defaultCurrency);
        const amountReport = convertAmount(raw, expenseCurrency, reportCurrency, eurRates);
        totalExpenses += amountReport;
        const serialized = serializeDoc(doc);
        expensesBreakdown.push({
          id: serialized._id,
          title: serialized.title,
          amount: raw,
          currency: expenseCurrency,
          amountReport,
          expense_date: serialized.expense_date,
          category: serialized.category ?? '',
        });
      });

      expensesBreakdown.sort((left, right) =>
        String(right.expense_date ?? '').localeCompare(String(left.expense_date ?? '')),
      );
    }

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
    const tax = homeScope
      ? null
      : computeTaxProjection(taxMode, { grossProfit, totalIncome });
    const austria =
      !homeScope && taxMode === 'at-self-employed' && tax
        ? {
            socialInsuranceRate: tax.socialInsuranceRate,
            socialInsurance: tax.socialInsurance,
            taxableBase: tax.taxableBase,
            incomeTax: tax.incomeTax,
            netProfit: tax.netProfit,
          }
        : null;

    const payload = {
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
      tax,
      austria,
      lessonsBreakdown,
      expensesBreakdown,
    };
    if (homeScope) {
      payload.students = studentsHome;
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
