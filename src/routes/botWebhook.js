const express = require('express');
const router = express.Router();
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const {
  enrichLessonSnapshot,
  normalizeLessonStatus,
  lessonRevenueFromSnapshot,
} = require('../utils/lessonSnapshot');
const { writeActivityLog } = require('../utils/activityLog');
const { resolveTutorName } = require('../utils/tutorName');
const { resolveTutorTimezone } = require('../utils/lessonNotifyTime');
const { resolveActiveVacation } = require('../utils/userWorkspaceSettings');

const ALLOWED_LANG = new Set(['ru', 'en', 'de']);

const crypto = require('crypto');

function requireBotSecret(req, res, next) {
  const expected = String(process.env.BOT_API_SECRET || '');
  const given = String(req.get('X-Bot-Secret') || '');
  if (!expected) {
    return res.status(401).json({ message: 'invalid bot secret' });
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: 'invalid bot secret' });
  }
  return next();
}

router.use(requireBotSecret);

/**
 * Bot → backend callbacks (no tutor JWT). Auth: X-Bot-Secret.
 */
router.post('/telegram-linked', async (req, res, next) => {
  try {
    const {
      student_id: rawStudentId,
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
      telegram_display_name: telegramDisplayName,
      telegram_chat_id: telegramChatId,
      role: bodyRole,
    } = req.body || {};

    if (!rawStudentId || !telegramUserId || !telegramChatId) {
      return res.status(400).json({
        message: 'student_id, telegram_user_id and telegram_chat_id are required',
      });
    }

    const rawId = String(rawStudentId);
    const isParent =
      bodyRole === 'parent' || rawId.endsWith('__parent') || rawId.startsWith('parent:');
    const studentId = isParent
      ? rawId.replace(/__parent$/, '').replace(/^parent:/, '')
      : rawId;

    const studentRef = db.collection('students').doc(studentId);
    const snap = await studentRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const username = telegramUsername ? String(telegramUsername).replace(/^@/, '') : null;
    const displayName = telegramDisplayName ? String(telegramDisplayName).trim() : null;
    const chatId = String(telegramChatId);
    const userId = String(telegramUserId);

    if (isParent) {
      await studentRef.update({
        telegram_parent_chat_id: chatId,
        telegram_parent_username: username,
        telegram_parent_linked_at: FieldValue.serverTimestamp(),
        is_minor: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await studentRef.update({
        telegram_user_id: userId,
        telegram_username: username,
        telegram_display_name: displayName,
        telegram_chat_id: chatId,
        telegram_linked_at: FieldValue.serverTimestamp(),
        telegram_unlink_pending: false,
        telegram_unlinked_username: null,
        telegram_delivery_status: 'ok',
        telegram_delivery_error: null,
        bot_active: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const updated = serializeDoc(await studentRef.get());
    res.json({
      ok: true,
      student_id: updated._id,
      role: isParent ? 'parent' : 'student',
      bot_lang: updated.bot_lang || 'de',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/telegram-unlinked', async (req, res, next) => {
  try {
    const {
      student_id: studentId,
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
      telegram_chat_id: telegramChatId,
    } = req.body || {};

    if (!studentId) {
      return res.status(400).json({ message: 'student_id is required' });
    }

    const studentRef = db.collection('students').doc(String(studentId));
    const snap = await studentRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const before = snap.data();
    const username =
      (telegramUsername && String(telegramUsername).replace(/^@/, '')) ||
      before.telegram_username ||
      null;

    await studentRef.update({
      bot_active: false,
      telegram_user_id: null,
      telegram_username: null,
      telegram_display_name: null,
      telegram_chat_id: null,
      telegram_linked_at: null,
      telegram_unlinked_at: FieldValue.serverTimestamp(),
      telegram_unlink_pending: true,
      telegram_unlinked_username: username,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await writeActivityLog({
      tutorId: before.tutor_id,
      category: 'students',
      action: 'student.telegram_unlinked',
      entityType: 'student',
      entityId: studentId,
      studentName: before.name,
      metadata: {
        telegram_user_id: telegramUserId || before.telegram_user_id || null,
        telegram_username: username,
        telegram_chat_id: telegramChatId || before.telegram_chat_id || null,
      },
    });

    res.json({
      ok: true,
      student_id: studentId,
      student_name: before.name || null,
      telegram_username: username,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/students/:id/lessons', async (req, res, next) => {
  try {
    const studentId = String(req.params.id);
    const studentSnap = await db.collection('students').doc(studentId).get();
    if (!studentSnap.exists) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const student = serializeDoc(studentSnap);
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));

    const lessonsSnap = await db.collection('lessons').where('student_id', '==', studentId).get();
    const studentById = new Map([[studentId, student]]);
    const now = Date.now();
    const items = serializeQuerySnapshot(lessonsSnap)
      .map((lesson) => enrichLessonSnapshot(lesson, studentById))
      .filter((lesson) => {
        const status = normalizeLessonStatus(lesson.status);
        if (status === 'completed' || status === 'missed' || status === 'canceled') {
          return true;
        }
        const at = lesson.scheduledAt ? Date.parse(lesson.scheduledAt) : NaN;
        return !Number.isNaN(at) && at < now;
      })
      .sort((a, b) => {
        const l = a.scheduledAt ? Date.parse(a.scheduledAt) : 0;
        const r = b.scheduledAt ? Date.parse(b.scheduledAt) : 0;
        return r - l;
      })
      .slice(0, limit)
      .map((lesson) => {
        const status = normalizeLessonStatus(lesson.status);
        const price = lessonRevenueFromSnapshot(lesson);
        return {
          id: lesson._id,
          scheduledAt: lesson.scheduledAt || null,
          status,
          duration_minutes: Number(lesson.lesson_duration) || 60,
          price,
          currency: lesson.lesson_currency || student.rate_currency || 'EUR',
        };
      });

    res.json({
      student_id: studentId,
      timezone: student.timezone || 'UTC',
      items,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/students/:id/payment-summary', async (req, res, next) => {
  try {
    const studentId = String(req.params.id);
    const studentSnap = await db.collection('students').doc(studentId).get();
    if (!studentSnap.exists) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const student = serializeDoc(studentSnap);
    const balance = Number(student.balance_lessons) || 0;
    const unpaid = Number(student.unpaid_lessons_count) || 0;
    const creditLimit = Number(student.credit_limit) || 0;
    const rate = Number(student.rate_per_hour) || 0;
    const currency = student.rate_currency || 'EUR';
    const billingType = student.billing_type === 'postpaid' ? 'postpaid' : 'package';
    const rateUnit = student.rate_unit === 'lesson' ? 'lesson' : 'hour';

    const lessonsSnap = await db.collection('lessons').where('student_id', '==', studentId).get();
    let completed = 0;
    let earned = 0;
    let unitsConsumed = 0;
    lessonsSnap.forEach((doc) => {
      const lesson = enrichLessonSnapshot({ _id: doc.id, ...doc.data() }, new Map([[studentId, student]]));
      if (normalizeLessonStatus(lesson.status) === 'completed') {
        completed += 1;
        earned += lessonRevenueFromSnapshot(lesson);
        if (lesson.balance_units_debited != null && Number(lesson.balance_units_debited) > 0) {
          unitsConsumed += Number(lesson.balance_units_debited);
        } else if (rateUnit === 'hour') {
          const minutes = Number(lesson.lesson_duration) || 60;
          unitsConsumed += Math.round((minutes / 60) * 100) / 100;
        } else {
          unitsConsumed += 1;
        }
      }
    });
    unitsConsumed = Math.round(unitsConsumed * 100) / 100;

    // Пополнено: total_topup_units (если ведётся), иначе остаток + списанное.
    const storedTopup = Number(student.total_topup_units);
    const inferredTopup = Math.round((balance + unitsConsumed) * 100) / 100;
    const toppedUp =
      billingType === 'package'
        ? Number.isFinite(storedTopup) && storedTopup > 0
          ? Math.round(Math.max(storedTopup, inferredTopup) * 100) / 100
          : inferredTopup
        : completed;
    // package: оплачено ≈ ставка × пополненные единицы (даже без completed-уроков).
    // postpaid hour: фактическая выручка по урокам.
    const paidAmount =
      rate > 0 && (billingType === 'package' || rateUnit === 'lesson')
        ? Math.round(toppedUp * rate * 100) / 100
        : Math.round(earned * 100) / 100;

    res.json({
      student_id: studentId,
      billing_type: billingType,
      balance_lessons: balance,
      balance_unit: rateUnit,
      unpaid_lessons_count: unpaid,
      credit_limit: creditLimit,
      lessons_completed: completed,
      lessons_topped_up: toppedUp,
      rate_per_hour: rate,
      rate_currency: currency,
      rate_unit: rateUnit,
      paid_amount: paidAmount,
      earned_amount: Math.round(earned * 100) / 100,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/students/:id/language', async (req, res, next) => {
  try {
    const studentId = String(req.params.id);
    const lang = String(req.body?.lang || '')
      .trim()
      .toLowerCase();
    if (!ALLOWED_LANG.has(lang)) {
      return res.status(400).json({ message: 'invalid lang' });
    }
    const studentRef = db.collection('students').doc(studentId);
    const snap = await studentRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Student not found' });
    }
    await studentRef.update({
      bot_lang: lang,
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, student_id: studentId, bot_lang: lang });
  } catch (error) {
    next(error);
  }
});

router.get('/students/:id/profile', async (req, res, next) => {
  try {
    const studentId = String(req.params.id);
    const snap = await db.collection('students').doc(studentId).get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const student = serializeDoc(snap);
    const tutorId = student.tutor_id || null;
    const tutorName = tutorId ? await resolveTutorName(tutorId) : null;
    let vacationActive = false;
    let vacationMessage = '';
    let vacationEndDate = '';
    let vacationStartDate = '';
    if (tutorId) {
      const tutorSnap = await db.collection('users').doc(String(tutorId)).get();
      const tz = await resolveTutorTimezone(tutorId);
      const vacation = resolveActiveVacation(
        tutorSnap.exists ? tutorSnap.data()?.vacation : null,
        tz,
      );
      vacationActive = vacation.active;
      vacationMessage = vacation.message || '';
      vacationEndDate = vacation.endDate || '';
      vacationStartDate = vacation.startDate || '';
    }
    res.json({
      student_id: studentId,
      name: student.name || null,
      subject: student.subject ? String(student.subject).trim().slice(0, 120) : null,
      bot_lang: ALLOWED_LANG.has(student.bot_lang) ? student.bot_lang : 'de',
      bot_active: Boolean(student.bot_active),
      telegram_username: student.telegram_username || null,
      tutor_name: tutorName,
      vacation_active: vacationActive,
      vacation_message: vacationMessage,
      vacation_end_date: vacationEndDate,
      vacation_start_date: vacationStartDate,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
