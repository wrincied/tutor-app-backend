const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const { generatePastelColor } = require('../utils/pastelColor');
const { normalizeBillingType, normalizeRateUnit, parseNonNegativeInt, parseBalanceAmount } = require('../utils/studentBilling');
const { studentSnapshotFromStudent } = require('../utils/lessonSnapshot');
const {
  collectPatchChanges,
  listActivityLogs,
  writeActivityLog,
} = require('../utils/activityLog');
const {
  newLinkToken,
  registerStudentLink,
  setBotActive,
  unlinkStudent,
  notifyPayment,
  withTelegramDeepLink,
} = require('../utils/telegramBot');
const { resolveTutorName } = require('../utils/tutorName');
const {
  normalizeTelegramSettings,
  mapDeliveryError,
} = require('../utils/telegramNotificationSettings');
const {
  maxStudentsForPlan,
  hasTelegramAccess,
  subscriptionLabel,
} = require('../utils/userProfile');

const ALLOWED_CURRENCY = new Set(['BYN', 'PLN', 'EUR', 'USD', 'RUB', 'KZT', 'UAH']);

async function loadTutorSubscriptionStatus(tutorId) {
  const snap = await db.collection('users').doc(String(tutorId)).get();
  if (!snap.exists) {
    return 'free';
  }
  return subscriptionLabel(snap.data()?.subscription_status);
}

function normalizeMeetingLink(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 2000) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return trimmed;
}

async function ensureTelegramLink(studentId, { name, botActive, existingToken, tutorId }) {
  if (!botActive) {
    if (existingToken) {
      await setBotActive({ studentId, botActive: false });
    }
    return { telegram_link_token: existingToken || null };
  }
  const token = existingToken || newLinkToken();
  const tutorName = tutorId ? await resolveTutorName(tutorId) : null;
  await registerStudentLink({
    studentId,
    linkToken: token,
    studentName: name,
    tutorName,
    botActive: true,
  });
  return { telegram_link_token: token };
}

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
      // Не блокируем ответ: цвета уже проставлены в payload.
      Promise.all(backfill).catch(() => {});
    }
    students.sort((left, right) => {
      const l = left.createdAt ? Date.parse(left.createdAt) : 0;
      const r = right.createdAt ? Date.parse(right.createdAt) : 0;
      return r - l;
    });
    res.json(students.map(withTelegramDeepLink));
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
    res.json(withTelegramDeepLink(serializeDoc(studentSnap)));
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
      bot_active,
      meeting_link,
    } = req.body;

    const normalizedName = name ? String(name).trim().slice(0, 120) : '';
    if (!normalizedName) {
      return res.status(400).json({ message: 'name is required' });
    }

    const planStatus = await loadTutorSubscriptionStatus(tutorId);
    const maxStudents = maxStudentsForPlan(planStatus);

    const ratePerHour = Number(rate_per_hour);
    if (Number.isNaN(ratePerHour) || ratePerHour < 0 || ratePerHour > 1_000_000) {
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
      billingType === 'package' ? parseBalanceAmount(balance_lessons, rateUnit, 0) : 0;
    const initialCreditLimit =
      billingType === 'postpaid' ? parseNonNegativeInt(credit_limit, 0) : 0;
    let botActive = Boolean(bot_active);
    if (botActive && !hasTelegramAccess(planStatus)) {
      botActive = false;
    }
    const meetingLink = normalizeMeetingLink(meeting_link);
    if (meeting_link !== undefined && meetingLink === undefined) {
      return res.status(400).json({ message: 'Invalid meeting_link' });
    }

    const createdRef = db.collection('students').doc();
    try {
      await db.runTransaction(async (tx) => {
        if (maxStudents !== null) {
          const countSnap = await tx.get(db.collection('students').where('tutor_id', '==', tutorId));
          if (countSnap.size >= maxStudents) {
            const err = new Error(`Student limit reached for your plan (${maxStudents})`);
            err.status = 403;
            err.code = 'PLAN_STUDENT_LIMIT';
            err.max_students = maxStudents;
            throw err;
          }
        }
        tx.set(createdRef, {
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
          bot_active: botActive,
          meeting_link: meetingLink ?? null,
          timezone: timezone ? String(timezone).trim().slice(0, 80) : 'Europe/Vienna',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (error) {
      if (error?.code === 'PLAN_STUDENT_LIMIT') {
        return res.status(403).json({
          code: 'PLAN_STUDENT_LIMIT',
          message: error.message,
          max_students: error.max_students,
        });
      }
      throw error;
    }

    if (botActive) {
      const { telegram_link_token } = await ensureTelegramLink(createdRef.id, {
        name: normalizedName,
        botActive: true,
        existingToken: null,
        tutorId,
      });
      if (telegram_link_token) {
        await createdRef.update({
          telegram_link_token,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    const createdSnap = await createdRef.get();
    const created = withTelegramDeepLink(serializeDoc(createdSnap));
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
      meeting_link,
      telegram_unlink_pending,
      telegram_notification_settings,
      is_minor,
    } = req.body;
    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (name !== undefined) {
      const nextName = String(name).trim().slice(0, 120);
      if (!nextName) {
        return res.status(400).json({ message: 'name is required' });
      }
      patch.name = nextName;
    }
    if (rate_per_hour !== undefined) {
      const ratePerHour = Number(rate_per_hour);
      if (Number.isNaN(ratePerHour) || ratePerHour < 0 || ratePerHour > 1_000_000) {
        return res.status(400).json({ message: 'rate_per_hour must be a non-negative number' });
      }
      patch.rate_per_hour = ratePerHour;
    }
    if (rate_currency !== undefined && ALLOWED_CURRENCY.has(rate_currency)) {
      patch.rate_currency = rate_currency;
    }
    if (timezone !== undefined) {
      patch.timezone = String(timezone).trim().slice(0, 80);
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
      const rateForBalance =
        rate_unit !== undefined
          ? normalizeRateUnit(rate_unit)
          : normalizeRateUnit(before.rate_unit);
      patch.balance_lessons = parseBalanceAmount(balance_lessons, rateForBalance, 0, {
        allowNegative: true,
        max: 10_000,
      });
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
      const nextActive = Boolean(bot_active);
      if (nextActive && !hasTelegramAccess(await loadTutorSubscriptionStatus(tutorId))) {
        return res.status(403).json({
          code: 'PLAN_TELEGRAM_REQUIRED',
          message: 'Telegram bot requires Pro or Trial',
        });
      }
      patch.bot_active = nextActive;
    }
    if (meeting_link !== undefined) {
      const meetingLink = normalizeMeetingLink(meeting_link);
      if (meetingLink === undefined) {
        return res.status(400).json({ message: 'Invalid meeting_link' });
      }
      patch.meeting_link = meetingLink;
    }
    if (telegram_unlink_pending !== undefined) {
      patch.telegram_unlink_pending = Boolean(telegram_unlink_pending);
      if (!patch.telegram_unlink_pending) {
        patch.telegram_unlinked_username = null;
      }
    }
    if (telegram_notification_settings !== undefined) {
      patch.telegram_notification_settings = normalizeTelegramSettings(
        telegram_notification_settings,
      );
    }
    if (is_minor !== undefined) {
      patch.is_minor = Boolean(is_minor);
    }

    const nextBotActive =
      bot_active !== undefined ? Boolean(bot_active) : Boolean(before.bot_active);
    const nextName = patch.name !== undefined ? patch.name : before.name;
    const { telegram_link_token } = await ensureTelegramLink(req.params.id, {
      name: nextName,
      botActive: nextBotActive,
      existingToken: before.telegram_link_token || null,
      tutorId,
    });
    if (nextBotActive && telegram_link_token) {
      patch.telegram_link_token = telegram_link_token;
    }

    await studentRef.update(patch);
    const updatedSnap = await studentRef.get();
    const updated = withTelegramDeepLink(serializeDoc(updatedSnap));
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

router.post('/:id/telegram-disconnect', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const before = studentSnap.data();
    if (!before.telegram_user_id && !before.telegram_chat_id) {
      return res.json(withTelegramDeepLink(serializeDoc(studentSnap)));
    }

    await studentRef.update({
      bot_active: false,
      telegram_user_id: null,
      telegram_username: null,
      telegram_display_name: null,
      telegram_chat_id: null,
      telegram_linked_at: null,
      telegram_unlink_pending: false,
      telegram_unlinked_username: null,
      telegram_unlinked_at: FieldValue.serverTimestamp(),
      telegram_delivery_status: null,
      telegram_delivery_error: null,
      telegram_parent_chat_id: null,
      telegram_parent_username: null,
      telegram_parent_linked_at: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Best-effort: clear bot SQLite binding so notifies stop immediately.
    void unlinkStudent({ studentId: req.params.id });

    await writeActivityLog({
      tutorId,
      category: 'students',
      action: 'student.telegram_disconnected',
      entityType: 'student',
      entityId: req.params.id,
      studentName: before.name,
      metadata: {
        telegram_user_id: before.telegram_user_id || null,
        telegram_username: before.telegram_username || null,
      },
    });

    const updated = withTelegramDeepLink(serializeDoc(await studentRef.get()));
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/topup', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const lessonsToAdd = Number(req.body.lessons);
    if (Number.isNaN(lessonsToAdd) || lessonsToAdd <= 0 || lessonsToAdd > 10_000) {
      return res.status(400).json({ message: 'lessons must be a positive number' });
    }

    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const before = studentSnap.data();
    const rateUnit = normalizeRateUnit(before.rate_unit);
    const added = parseBalanceAmount(lessonsToAdd, rateUnit, 0);
    if (added <= 0) {
      return res.status(400).json({ message: 'lessons must be a positive number' });
    }

    const currency = ALLOWED_CURRENCY.has(before.rate_currency) ? before.rate_currency : 'EUR';
    const rate = Number(before.rate_per_hour) || 0;
    const moneyRaw = req.body.money_amount;
    const moneyAmount =
      moneyRaw !== undefined && moneyRaw !== null && moneyRaw !== ''
        ? Number(moneyRaw)
        : rate > 0
          ? Math.round(rate * added * 100) / 100
          : 0;
    if (Number.isNaN(moneyAmount) || moneyAmount < 0) {
      return res.status(400).json({ message: 'money_amount must be a non-negative number' });
    }

    let paidAt = new Date();
    if (req.body.paid_at) {
      const parsed = new Date(String(req.body.paid_at));
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: 'paid_at must be a valid date' });
      }
      paidAt = parsed;
    }

    const last_topup = {
      amount_money: moneyAmount,
      currency,
      units: added,
      at: paidAt.toISOString(),
    };

    await studentRef.update({
      balance_lessons: FieldValue.increment(added),
      total_topup_units: FieldValue.increment(added),
      last_topup,
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
      metadata: {
        added,
        rate_unit: rateUnit,
        money_amount: moneyAmount,
        currency,
        paid_at: last_topup.at,
      },
    });

    let telegram_receipt_sent = false;
    const settings = normalizeTelegramSettings(updated.telegram_notification_settings);
    const wantsReceipt =
      req.body.send_receipt !== undefined
        ? Boolean(req.body.send_receipt)
        : settings.payment_receipt_enabled;
    const canNotify =
      wantsReceipt &&
      updated.bot_active &&
      (updated.telegram_user_id || updated.telegram_chat_id) &&
      updated.telegram_delivery_status !== 'error';

    if (canNotify) {
      const unitLabel = rateUnit === 'lesson' ? 'ур.' : 'ч';
      const amountLabel =
        moneyAmount > 0 && currency
          ? `${moneyAmount} ${currency}`
          : rate > 0 && currency
            ? `${(rate * added).toFixed(rate % 1 || added % 1 ? 2 : 0)} ${currency}`
            : `+${added} ${unitLabel}`;
      try {
        const notifyResult = await notifyPayment({
          studentId: updated._id,
          amountLabel,
          lessonsAdded: added,
          rateUnit,
          tutorName: await resolveTutorName(tutorId),
        });
        if (notifyResult?.ok) {
          telegram_receipt_sent = true;
          if (updated.telegram_delivery_status === 'error') {
            await studentRef.update({
              telegram_delivery_status: 'ok',
              telegram_delivery_error: null,
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        } else if (!notifyResult?.skipped) {
          const code = mapDeliveryError(notifyResult);
          await studentRef.update({
            telegram_delivery_status: 'error',
            telegram_delivery_error: code,
            updatedAt: FieldValue.serverTimestamp(),
          });
          updated.telegram_delivery_status = 'error';
          updated.telegram_delivery_error = code;
        }
      } catch {
        // Не блокируем ответ CRM.
      }
    }

    res.json({
      ...withTelegramDeepLink(updated),
      telegram_receipt_sent,
    });
  } catch (error) {
    next(error);
  }
});

const BALANCE_ADJUST_REASONS = new Set(['no_show', 'bonus', 'typo']);

router.post('/:id/balance-adjust', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const reason = String(req.body.reason || '');
    if (!BALANCE_ADJUST_REASONS.has(reason)) {
      return res.status(400).json({ message: 'reason must be no_show, bonus, or typo' });
    }

    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const before = studentSnap.data();
    const rateUnit = normalizeRateUnit(before.rate_unit);
    const nextBalance = parseBalanceAmount(req.body.balance_lessons, rateUnit, 0, {
      allowNegative: true,
    });
    if (Number.isNaN(Number(req.body.balance_lessons))) {
      return res.status(400).json({ message: 'balance_lessons must be a number' });
    }

    const from = Number(before.balance_lessons) || 0;
    await studentRef.update({
      balance_lessons: nextBalance,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const updated = serializeDoc(await studentRef.get());

    await writeActivityLog({
      tutorId,
      category: 'students',
      action: 'student.balance_adjust',
      entityType: 'student',
      entityId: updated._id,
      studentName: updated.name,
      changes: [
        {
          field: 'balance_lessons',
          from,
          to: Number(updated.balance_lessons) || 0,
        },
      ],
      metadata: { reason, rate_unit: rateUnit, notify_telegram: Boolean(req.body.notify_telegram) },
    });

    let telegram_notified = false;
    const wantsNotify = Boolean(req.body.notify_telegram);
    const canNotify =
      wantsNotify &&
      updated.bot_active &&
      (updated.telegram_user_id || updated.telegram_chat_id) &&
      updated.telegram_delivery_status !== 'error';

    if (canNotify) {
      try {
        const unitLabel = rateUnit === 'lesson' ? 'ур.' : 'ч';
        const amountLabel = `${from} → ${nextBalance} ${unitLabel}`;
        const notifyResult = await notifyPayment({
          studentId: updated._id,
          amountLabel,
          lessonsAdded: nextBalance - from,
          rateUnit,
          tutorName: await resolveTutorName(tutorId),
        });
        if (notifyResult?.ok) {
          telegram_notified = true;
        } else if (!notifyResult?.skipped) {
          const code = mapDeliveryError(notifyResult);
          await studentRef.update({
            telegram_delivery_status: 'error',
            telegram_delivery_error: code,
            updatedAt: FieldValue.serverTimestamp(),
          });
          updated.telegram_delivery_status = 'error';
          updated.telegram_delivery_error = code;
        }
      } catch {
        // CRM response not blocked.
      }
    }

    res.json({
      ...withTelegramDeepLink(updated),
      telegram_notified,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id/telegram-settings', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    if (!hasTelegramAccess(await loadTutorSubscriptionStatus(tutorId))) {
      return res.status(403).json({
        code: 'PLAN_TELEGRAM_REQUIRED',
        message: 'Telegram bot requires Pro or Trial',
      });
    }
    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const settings = normalizeTelegramSettings(req.body);
    await studentRef.update({
      telegram_notification_settings: settings,
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json(withTelegramDeepLink(serializeDoc(await studentRef.get())));
  } catch (error) {
    next(error);
  }
});

/** True if chatId is already bound on another student (any of the TG id fields). */
async function findConflictingTelegramChat(chatId, excludeStudentId) {
  const fields = ['telegram_chat_id', 'telegram_user_id', 'telegram_parent_chat_id'];
  const seen = new Set();
  for (const field of fields) {
    const snap = await db.collection('students').where(field, '==', chatId).limit(5).get();
    for (const doc of snap.docs) {
      if (doc.id === excludeStudentId || seen.has(doc.id)) {
        continue;
      }
      seen.add(doc.id);
      return doc;
    }
  }
  return null;
}

router.post('/:id/telegram-link-manual', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    if (!hasTelegramAccess(await loadTutorSubscriptionStatus(tutorId))) {
      return res.status(403).json({
        code: 'PLAN_TELEGRAM_REQUIRED',
        message: 'Telegram bot requires Pro or Trial',
      });
    }
    const chatId = String(req.body.chat_id || '').trim();
    const role = req.body.role === 'parent' ? 'parent' : 'student';
    if (!/^-?\d{5,20}$/.test(chatId)) {
      return res.status(400).json({ message: 'chat_id must be a numeric Telegram chat id' });
    }
    if (req.body.confirm_recipient_consent !== true) {
      return res.status(400).json({
        message: 'confirm_recipient_consent is required — recipient must agree to receive bot messages',
      });
    }

    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const conflict = await findConflictingTelegramChat(chatId, req.params.id);
    if (conflict) {
      return res.status(409).json({
        message: 'This Telegram chat is already linked to another student',
      });
    }

    const patch = {
      telegram_delivery_status: 'ok',
      telegram_delivery_error: null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (role === 'parent') {
      patch.telegram_parent_chat_id = chatId;
      patch.telegram_parent_linked_at = FieldValue.serverTimestamp();
      patch.is_minor = true;
    } else {
      patch.telegram_chat_id = chatId;
      patch.telegram_user_id = chatId;
      patch.telegram_linked_at = FieldValue.serverTimestamp();
      patch.bot_active = true;
    }

    await studentRef.update(patch);
    if (role === 'student') {
      const before = studentSnap.data();
      const { telegram_link_token } = await ensureTelegramLink(req.params.id, {
        name: before.name,
        botActive: true,
        existingToken: before.telegram_link_token || null,
        tutorId,
      });
      if (telegram_link_token) {
        await studentRef.update({ telegram_link_token });
      }
    }

    res.json(withTelegramDeepLink(serializeDoc(await studentRef.get())));
  } catch (error) {
    next(error);
  }
});

/** POST /api/students/:id/resync-lesson-snapshots — переснять ставку на всех уроках ученика. */
router.post('/:id/resync-lesson-snapshots', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const studentRef = db.collection('students').doc(req.params.id);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const studentData = studentSnap.data();
    const snapshot = studentSnapshotFromStudent(studentData);
    const lessonsSnap = await db.collection('lessons').where('tutor', '==', tutorId).get();
    const docs = lessonsSnap.docs.filter((doc) => doc.data().student_id === req.params.id);

    if (docs.length === 0) {
      return res.json({ updated: 0 });
    }

    const chunkSize = 450;
    let updated = 0;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const batch = db.batch();
      const chunk = docs.slice(i, i + chunkSize);
      for (const doc of chunk) {
        batch.update(doc.ref, {
          ...snapshot,
          student_name: studentData.name || doc.data().student_name || null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      updated += chunk.length;
    }

    await writeActivityLog({
      tutorId,
      category: 'students',
      action: 'student.resync_lesson_snapshots',
      entityType: 'student',
      entityId: req.params.id,
      studentName: studentData.name,
      changes: [],
      metadata: {
        updated,
        lesson_price: snapshot.lesson_price,
        price_mode: snapshot.price_mode,
        lesson_currency: snapshot.lesson_currency,
      },
    });

    res.json({ updated });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
