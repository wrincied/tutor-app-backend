const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireVerifiedEmail = require('../middleware/requireVerifiedEmail');
const checkLessonCollision = require('../middleware/lessonCollision');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');
const {
  studentSnapshotFromStudent,
  enrichLessonSnapshot,
  lessonHasCompleteSnapshot,
  normalizeLessonStatus,
} = require('../utils/lessonSnapshot');
const {
  applyLessonStatusBilling,
  applyLessonBalanceOnCreate,
  appendBalanceLog,
  isCompletedStatus,
  isMissedOrCanceledStatus,
  cancelLessonWithBilling,
} = require('../services/lessonBilling');
const {
  normalizeRecurrenceFields,
  dayKeyFromDate,
  lessonWithEffectiveSchedule,
  normalizeOccurrenceOverrides,
  applyAnchorTime,
  withRruleUntil,
  withRruleTargetDay,
  occurrenceDatesBetween,
  firstOccurrenceOnOrAfter,
  parseRruleParts,
  lessonOccurrenceIntervals,
} = require('../utils/lessonRecurrence');
const { normalizeOccurrenceDate, applyRecurringOccurrenceStatus, excludeRecurringOccurrence, occurrenceBalanceDebited, uniqueDates, hadOccurrenceBillingMarker } = require('../services/lessonOccurrence');
const { notifyLessonMoved } = require('../utils/telegramBot');
const { resolveTutorName } = require('../utils/tutorName');
const {
  formatLessonTimeLabel,
  resolveTutorTimezone,
  scheduleTimesEqual,
} = require('../utils/lessonNotifyTime');
const { fetchTutorLessonsForPeriod } = require('../utils/tutorLessonsQuery');
const { heavyReadLimiter } = require('../middleware/rateLimit');

const limitHeavyLessons = heavyReadLimiter();
const ALLOWED_STATUS = new Set(['scheduled', 'completed', 'missed', 'canceled', 'cancelled']);

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

function isRecurringSeries(lesson) {
  return lesson?.isRecurring === true || Boolean(lesson?.rrule);
}

function resolveOccurrenceDate(body, existing) {
  const direct = normalizeOccurrenceDate(body.occurrence_date);
  if (direct) {
    return direct;
  }
  const scheduledRaw = body.scheduledAt ?? existing?.scheduledAt;
  if (!scheduledRaw) {
    return null;
  }
  const parsed = new Date(scheduledRaw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return normalizeOccurrenceDate(dayKeyFromDate(parsed));
}

function clampDuration(raw) {
  const minutes = Number(raw);
  if (Number.isNaN(minutes)) {
    return 60;
  }
  return Math.min(480, Math.max(5, Math.round(minutes)));
}

async function ensureStudentOwned(studentId, tutorId) {
  if (!studentId) {
    return null;
  }
  const studentSnap = await db.collection('students').doc(studentId).get();
  if (!studentSnap.exists) {
    return null;
  }
  const studentData = studentSnap.data();
  if (studentData.tutor_id !== tutorId) {
    return null;
  }
  return studentData;
}

async function notifyLessonReschedule(tutorId, lesson, studentId, oldScheduledAt = null) {
  if (!studentId || !lesson?.scheduledAt) {
    console.log('[notifyLessonReschedule] skip: missing student/schedule', {
      studentId,
      scheduledAt: lesson?.scheduledAt,
    });
    return;
  }
  const { hasTelegramAccess, subscriptionLabel } = require('../utils/userProfile');
  const tutorSnap = await db.collection('users').doc(String(tutorId)).get();
  const tutorStatus = subscriptionLabel(
    tutorSnap.exists ? tutorSnap.data()?.subscription_status : 'free',
  );
  if (!hasTelegramAccess(tutorStatus)) {
    console.log('[notifyLessonReschedule] skip: tutor plan has no telegram', {
      tutorId,
      tutorStatus,
    });
    return;
  }
  const studentSnap = await db.collection('students').doc(String(studentId)).get();
  if (!studentSnap.exists) {
    console.log('[notifyLessonReschedule] skip: student not found', { studentId });
    return;
  }
  const student = studentSnap.data();
  const linked = Boolean(student?.telegram_user_id || student?.telegram_chat_id);
  if (!student?.bot_active || !linked) {
    console.log('[notifyLessonReschedule] skip: student bot inactive or not linked', {
      studentId,
      bot_active: student?.bot_active,
      has_user_id: Boolean(student?.telegram_user_id),
      has_chat_id: Boolean(student?.telegram_chat_id),
    });
    return;
  }
  const tz = await resolveTutorTimezone(tutorId);
  const tutorName = await resolveTutorName(tutorId);
  const meetingLink = student.meeting_link || lesson.meeting_link || null;
  const result = await notifyLessonMoved({
    studentId: String(studentId),
    newTimeLabel: formatLessonTimeLabel(lesson.scheduledAt, tz),
    meetingLink,
    tutorName,
    subject: student.subject || null,
    oldScheduledAt: oldScheduledAt || null,
    newScheduledAt: lesson.scheduledAt || null,
    timezone: tz,
  });
  console.log('[notifyLessonReschedule] result', {
    studentId,
    ok: result?.ok,
    error: result?.error || null,
    skipped: result?.skipped || false,
  });
}

router.use(auth);
router.use(requireVerifiedEmail);

router.get('/', limitHeavyLessons, async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const from = parseDateQuery(String(req.query.from || ''));
    const to = parseDateQuery(String(req.query.to || ''));
    if (!from || !to) {
      return res.status(400).json({
        message: 'Query params from and to (YYYY-MM-DD) are required',
      });
    }

    const lessonsSnap = await fetchTutorLessonsForPeriod(tutorId, { from, to });
    const lessonsRaw = lessonsSnap.docs.map((doc) => serializeDoc(doc));
    const needsStudents = lessonsRaw.some((lesson) => !lessonHasCompleteSnapshot(lesson));
    const studentById = new Map();
    if (needsStudents) {
      const studentsSnap = await db.collection('students').where('tutor_id', '==', tutorId).get();
      studentsSnap.forEach((doc) => {
        const row = serializeDoc(doc);
        studentById.set(row._id, row);
      });
    }
    const lessons = lessonsRaw.map((lesson) =>
      lessonWithEffectiveSchedule(enrichLessonSnapshot(lesson, studentById)),
    );
    lessons.sort((left, right) => {
      const l = left.scheduledAt ? Date.parse(left.scheduledAt) : 0;
      const r = right.scheduledAt ? Date.parse(right.scheduledAt) : 0;
      return r - l;
    });
    res.json(lessons);
  } catch (error) {
    if (error?.status === 400) {
      return res.status(400).json({ message: error.message });
    }
    next(error);
  }
});

router.post('/', checkLessonCollision, async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const {
      student_id,
      lesson_duration,
      status,
      title,
      notes,
      memo,
      scheduledAt,
    } = req.body;

    const normalizedStudentId = student_id || null;
    if (!normalizedStudentId) {
      return res.status(400).json({ message: 'student_id is required' });
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_price') ||
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_currency') ||
      Object.prototype.hasOwnProperty.call(req.body, 'price_mode')
    ) {
      return res.status(400).json({
        message: 'lesson_price, lesson_currency and price_mode are snapshot fields and cannot be set directly',
      });
    }

    const studentData = await ensureStudentOwned(normalizedStudentId, tutorId);
    if (!studentData) {
      return res.status(400).json({ message: 'Student not found' });
    }

    const ratePerHour = Number(studentData.rate_per_hour);
    if (Number.isNaN(ratePerHour) || ratePerHour < 0) {
      return res.status(400).json({ message: 'Student rate_per_hour is invalid' });
    }
    const snapshot = studentSnapshotFromStudent(studentData);

    const normalizedStatus = ALLOWED_STATUS.has(status) ? status : 'scheduled';
    const normalizedDuration = clampDuration(lesson_duration);

    if (
      isMissedOrCanceledStatus(normalizedStatus) &&
      !Object.prototype.hasOwnProperty.call(req.body, 'should_deduct_balance')
    ) {
      return res.status(400).json({
        message: 'should_deduct_balance is required when status is missed or canceled',
      });
    }
    const shouldDeductOnCreate = req.body.should_deduct_balance === true;

    const studentRef = db.collection('students').doc(normalizedStudentId);
    const createdRef = db.collection('lessons').doc();

    const recurrence = normalizeRecurrenceFields(req.body, scheduledAt);

    const lessonData = {
      tutor: tutorId,
      student_id: normalizedStudentId,
      student_name: studentData.name || null,
      lesson_price: snapshot.lesson_price,
      lesson_currency: snapshot.lesson_currency,
      price_mode: snapshot.price_mode,
      student_timezone: snapshot.student_timezone,
      lesson_duration: normalizedDuration,
      status: normalizedStatus,
      title: title ? String(title).trim() : '',
      notes: notes ? String(notes).trim() : '',
      memo: memo ? String(memo).trim() : '',
      scheduledAt: scheduledAt ? String(scheduledAt) : null,
      isRecurring: recurrence.isRecurring,
      startDate: recurrence.startDate,
      rrule: recurrence.rrule,
      exdates: [],
      completedDates: [],
      missedDates: [],
      canceledDates: [],
      reminder_sent: false,
      balance_debited: false,
      billing_processed: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const batch = db.batch();
    batch.set(createdRef, lessonData);
    if (isMissedOrCanceledStatus(normalizedStatus) || isCompletedStatus(normalizedStatus)) {
      applyLessonStatusBilling(batch, {
        tutorId,
        studentId: normalizedStudentId,
        studentName: studentData.name,
        studentRef,
        lessonRef: createdRef,
        lessonId: createdRef.id,
        previousStatus: 'scheduled',
        nextStatus: normalizedStatus,
        balanceDebited: false,
        billingProcessed: false,
        studentBillingType: studentData.billing_type,
        studentRateUnit: studentData.rate_unit,
        lessonDuration: lessonData.lesson_duration,
        shouldDeduct: shouldDeductOnCreate,
        autoDebitEnabled: studentData.auto_debit_enabled !== false,
        manualCompletion: req.body.manual_completion !== false,
        studentBalance: studentData.balance_lessons,
      });
    } else {
      applyLessonBalanceOnCreate(batch, {
        lessonRef: createdRef,
        status: normalizedStatus,
        autoDebitEnabled: studentData.auto_debit_enabled !== false,
      });
    }
    await batch.commit();

    const createdSnap = await createdRef.get();
    res.status(201).json(serializeDoc(createdSnap));
  } catch (error) {
    next(error);
  }
});

router.put('/:id', checkLessonCollision, async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const lessonRef = db.collection('lessons').doc(req.params.id);
    const lessonSnap = await lessonRef.get();

    if (!lessonSnap.exists || lessonSnap.data().tutor !== tutorId) {
      return res.status(404).json({ message: 'Lesson not found' });
    }

    const existing = lessonSnap.data();
    const seriesRecurring = isRecurringSeries(existing);
    const occurrenceDate = seriesRecurring ? resolveOccurrenceDate(req.body, existing) : null;
    let occurrenceStatusRaw = req.body.occurrence_status;
    // Drag & drop sends scheduledAt without occurrence fields — that is a schedule move,
    // never an occurrence status update (otherwise scheduledAt below would be dropped).
    const scheduleMoveOnly =
      Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt') &&
      req.body.occurrence_status === undefined &&
      !normalizeOccurrenceDate(req.body.occurrence_date);
    if (occurrenceStatusRaw === undefined && seriesRecurring && occurrenceDate && !scheduleMoveOnly) {
      const bodyStatus = req.body.status;
      if (
        bodyStatus !== undefined &&
        bodyStatus !== 'scheduled' &&
        ALLOWED_STATUS.has(String(bodyStatus))
      ) {
        occurrenceStatusRaw = bodyStatus;
      }
    }

    if (seriesRecurring && occurrenceDate && occurrenceStatusRaw !== undefined) {
      if (!existing.student_id) {
        return res.status(400).json({ message: 'student_id is required' });
      }
      const studentRef = db.collection('students').doc(existing.student_id);
      const studentSnap = await studentRef.get();
      if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
        return res.status(400).json({ message: 'Student not found' });
      }
      if (
        (occurrenceStatusRaw === 'missed' || occurrenceStatusRaw === 'canceled') &&
        !Object.prototype.hasOwnProperty.call(req.body, 'should_deduct_balance')
      ) {
        return res.status(400).json({
          message: 'should_deduct_balance is required when status is missed or canceled',
        });
      }
      const occurrenceWasMarked =
        occurrenceDate && hadOccurrenceBillingMarker(existing, occurrenceDate);
      if (
        occurrenceStatusRaw === 'scheduled' &&
        occurrenceWasMarked &&
        (await occurrenceBalanceDebited(lessonRef.id, occurrenceDate)) &&
        !Object.prototype.hasOwnProperty.call(req.body, 'should_refund_balance')
      ) {
        return res.status(400).json({
          message: 'should_refund_balance is required when restoring a debited occurrence',
        });
      }
      const manualCompletion = req.body.manual_completion !== false;
      const occurrenceBilling = {
        occurrenceDate,
        nextStatus: occurrenceStatusRaw,
        shouldDeduct: req.body.should_deduct_balance === true,
        shouldRefund: req.body.should_refund_balance === true,
        should_deduct_balance_raw: req.body.should_deduct_balance,
      };
      console.log('[billing] PUT occurrence status', {
        lessonId: lessonRef.id,
        ...occurrenceBilling,
      });
      const occurrenceResult = await applyRecurringOccurrenceStatus({
        tutorId,
        lessonRef,
        existing,
        occurrenceDate,
        nextStatus: occurrenceStatusRaw,
        shouldDeduct: occurrenceBilling.shouldDeduct,
        shouldRefund: occurrenceBilling.shouldRefund,
        autoDebitEnabled: studentSnap.data().auto_debit_enabled !== false,
        studentSnap,
        studentRef,
        billImmediately: manualCompletion,
      });
      console.log('[billing] PUT occurrence result', occurrenceResult);
    }

    const {
      student_id,
      lesson_duration,
      status,
      title,
      notes,
      memo,
      scheduledAt,
    } = req.body;

    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (seriesRecurring) {
      patch.status = 'scheduled';
    }

    const hasStudentField = Object.prototype.hasOwnProperty.call(req.body, 'student_id');
    if (hasStudentField) {
      const normalizedStudentId = student_id || null;
      const studentData = await ensureStudentOwned(normalizedStudentId, tutorId);
      if (normalizedStudentId && !studentData) {
        return res.status(400).json({ message: 'Student not found' });
      }
      const previousStudentId = existing.student_id ?? null;
      patch.student_id = normalizedStudentId;
      patch.student_name = studentData?.name || null;
      if (normalizedStudentId !== previousStudentId) {
        if (studentData) {
          Object.assign(patch, studentSnapshotFromStudent(studentData));
        } else {
          patch.lesson_price = 0;
          patch.lesson_currency = 'EUR';
          patch.price_mode = 'hourly';
          patch.student_timezone = 'UTC';
        }
      }
    }

    const refreshSnapshot = req.body.refresh_snapshot === true;
    if (refreshSnapshot) {
      const studentIdForSnapshot = patch.student_id ?? existing.student_id;
      if (!studentIdForSnapshot) {
        return res.status(400).json({ message: 'student_id is required to refresh snapshot' });
      }
      const studentData = await ensureStudentOwned(studentIdForSnapshot, tutorId);
      if (!studentData) {
        return res.status(400).json({ message: 'Student not found' });
      }
      Object.assign(patch, studentSnapshotFromStudent(studentData));
      if (studentData.name) {
        patch.student_name = studentData.name;
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_price') ||
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_currency') ||
      Object.prototype.hasOwnProperty.call(req.body, 'price_mode')
    ) {
      return res.status(400).json({
        message: 'lesson_price, lesson_currency and price_mode are snapshot fields and cannot be set directly',
      });
    }

    if (lesson_duration !== undefined) {
      patch.lesson_duration = clampDuration(lesson_duration);
    }
    if (status !== undefined && !seriesRecurring) {
      patch.status = ALLOWED_STATUS.has(status) ? status : existing.status;
    }
    if (title !== undefined) {
      patch.title = title ? String(title).trim() : '';
    }
    if (notes !== undefined) {
      patch.notes = notes ? String(notes).trim() : '';
    }
    if (memo !== undefined) {
      patch.memo = memo ? String(memo).trim() : '';
    }

    const occurrenceStatusOnly =
      seriesRecurring &&
      Boolean(occurrenceDate) &&
      occurrenceStatusRaw !== undefined;

    // Virtual occurrence saves send that day's scheduledAt — do not move series anchor.
    if (
      Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt') &&
      !occurrenceStatusOnly
    ) {
      patch.scheduledAt = scheduledAt ? String(scheduledAt) : null;
    }

    if (
      !occurrenceStatusOnly &&
      (Object.prototype.hasOwnProperty.call(req.body, 'isRecurring') ||
        Object.prototype.hasOwnProperty.call(req.body, 'rrule') ||
        Object.prototype.hasOwnProperty.call(req.body, 'startDate'))
    ) {
      const effectiveScheduledAt = Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt')
        ? scheduledAt
        : existing.scheduledAt;
      const recurrence = normalizeRecurrenceFields(
        {
          isRecurring: Object.prototype.hasOwnProperty.call(req.body, 'isRecurring')
            ? req.body.isRecurring
            : existing.isRecurring,
          rrule: Object.prototype.hasOwnProperty.call(req.body, 'rrule')
            ? req.body.rrule
            : existing.rrule,
          startDate: Object.prototype.hasOwnProperty.call(req.body, 'startDate')
            ? req.body.startDate
            : existing.startDate,
        },
        effectiveScheduledAt,
      );
      patch.isRecurring = recurrence.isRecurring;
      patch.rrule = recurrence.rrule;
      patch.startDate = recurrence.startDate;
      if (seriesRecurring && !recurrence.isRecurring) {
        patch.occurrenceOverrides = {};
        patch.exdates = [];
        patch.completedDates = [];
        patch.missedDates = [];
        patch.canceledDates = [];
      }
    }

    const scheduleChanged =
      !occurrenceStatusOnly &&
      Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt');
    const durationChanged = Object.prototype.hasOwnProperty.call(req.body, 'lesson_duration');
    if (scheduleChanged || durationChanged) {
      patch.reminder_sent = false;
      patch.post_lesson_notified = false;
    }

    const nextScheduledAt = scheduleChanged
      ? scheduledAt
        ? String(scheduledAt)
        : null
      : existing.scheduledAt;
    const timeActuallyMoved =
      scheduleChanged &&
      nextScheduledAt &&
      !scheduleTimesEqual(existing.scheduledAt, nextScheduledAt);

    const nextStatus = patch.status ?? existing.status;
    const studentIdForBalance = patch.student_id ?? existing.student_id;

    const batch = db.batch();
    batch.update(lessonRef, patch);

    if (!seriesRecurring) {
      const statusChangingToMissedCanceled =
        status !== undefined &&
        isMissedOrCanceledStatus(nextStatus) &&
        !isMissedOrCanceledStatus(existing.status);

      const statusRestoringFromMissedCanceled =
        status !== undefined &&
        isMissedOrCanceledStatus(existing.status) &&
        !isMissedOrCanceledStatus(nextStatus) &&
        !isCompletedStatus(nextStatus);

      const refundOnly =
        status !== undefined &&
        isMissedOrCanceledStatus(nextStatus) &&
        isMissedOrCanceledStatus(existing.status) &&
        normalizeLessonStatus(nextStatus) === normalizeLessonStatus(existing.status) &&
        req.body.should_refund_balance === true;

      if (
        statusChangingToMissedCanceled &&
        !Object.prototype.hasOwnProperty.call(req.body, 'should_deduct_balance')
      ) {
        return res.status(400).json({
          message: 'should_deduct_balance is required when status is missed or canceled',
        });
      }

      if (
        statusRestoringFromMissedCanceled &&
        existing.balance_debited &&
        !Object.prototype.hasOwnProperty.call(req.body, 'should_refund_balance')
      ) {
        return res.status(400).json({
          message: 'should_refund_balance is required when restoring a debited lesson',
        });
      }

      if (refundOnly && !existing.balance_debited) {
        return res.status(400).json({ message: 'Lesson balance was not debited' });
      }

      const shouldDeduct = req.body.should_deduct_balance === true;
      const shouldRefund = req.body.should_refund_balance === true;

      if (studentIdForBalance) {
        const studentRef = db.collection('students').doc(studentIdForBalance);
        const studentSnap = await studentRef.get();
        if (!studentSnap.exists || studentSnap.data().tutor_id !== tutorId) {
          return res.status(400).json({ message: 'Student not found' });
        }
        if (
          isCompletedStatus(nextStatus) &&
          studentSnap.data().auto_debit_enabled === false &&
          !isCompletedStatus(existing.status)
        ) {
          return res.status(400).json({
            message: 'Auto debit is disabled for this student',
          });
        }
        console.log('[billing] PUT single lesson billing', {
          lessonId: lessonRef.id,
          previousStatus: existing.status,
          nextStatus,
          shouldDeduct,
          shouldRefund,
          should_deduct_balance_raw: req.body.should_deduct_balance,
          balanceDebited: existing.balance_debited,
          billingType: studentSnap.data().billing_type,
          balanceBefore: studentSnap.data().balance_lessons,
          statusChangingToMissedCanceled,
        });
        const billingResult = applyLessonStatusBilling(batch, {
          tutorId,
          studentId: studentIdForBalance,
          studentName: studentSnap.data().name,
          studentRef,
          lessonRef,
          lessonId: lessonRef.id,
          previousStatus: existing.status,
          nextStatus,
          balanceDebited: existing.balance_debited,
          billingProcessed: existing.billing_processed,
          studentBillingType: studentSnap.data().billing_type,
          studentRateUnit: studentSnap.data().rate_unit,
          lessonDuration:
            patch.lesson_duration !== undefined ? patch.lesson_duration : existing.lesson_duration,
          balanceUnitsDebited: existing.balance_units_debited,
          shouldDeduct,
          shouldRefund,
          autoDebitEnabled: studentSnap.data().auto_debit_enabled !== false,
          manualCompletion: req.body.manual_completion !== false,
          studentBalance: studentSnap.data().balance_lessons,
        });
        console.log('[billing] PUT single lesson result', billingResult);
      }
    }

    await batch.commit();

    const updatedSnap = await lessonRef.get();
    const updated = serializeDoc(updatedSnap);

    if (timeActuallyMoved && normalizeLessonStatus(nextStatus) === 'scheduled') {
      const studentId = updated.student_id || studentIdForBalance;
      console.log('[notifyLessonReschedule] schedule moved, notifying', {
        lessonId: lessonRef.id,
        studentId,
        from: existing.scheduledAt,
        to: nextScheduledAt,
      });
      notifyLessonReschedule(tutorId, updated, studentId, existing.scheduledAt).catch((err) => {
        console.error('notifyLessonReschedule:', err.message);
      });
    } else if (scheduleChanged) {
      console.log('[notifyLessonReschedule] schedule field present but notify skipped', {
        lessonId: lessonRef.id,
        timeActuallyMoved,
        nextStatus,
        from: existing.scheduledAt,
        to: nextScheduledAt,
      });
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

function dateFromDayKey(dayKey, anchor) {
  const [y, m, d] = String(dayKey).slice(0, 10).split('-').map(Number);
  const base = new Date(y, m - 1, d, 0, 0, 0, 0);
  return anchor ? applyAnchorTime(base, anchor) : base;
}

function shiftDayKey(dayKey, days) {
  const date = dateFromDayKey(dayKey, null);
  date.setDate(date.getDate() + days);
  return dayKeyFromDate(date);
}

function occurrenceIsMarked(lesson, occurrenceDate) {
  return ['completedDates', 'missedDates', 'canceledDates'].some((field) =>
    (lesson[field] ?? []).some((item) => String(item).slice(0, 10) === occurrenceDate),
  );
}

/** Точечная проверка слота: пересечение нового времени с чужими scheduled-уроками. */
async function slotHasCollision(tutorId, { scheduledAt, durationMinutes, excludeId }) {
  const start = Date.parse(String(scheduledAt));
  if (Number.isNaN(start)) {
    return false;
  }
  const end = start + clampDuration(durationMinutes) * 60000;
  const rangeStart = new Date(start - 7 * 86400000);
  const rangeEnd = new Date(start + 7 * 86400000);
  const snap = await fetchTutorLessonsForPeriod(tutorId, {
    from: rangeStart,
    to: rangeEnd,
  });
  for (const doc of snap.docs) {
    if (doc.id === excludeId) {
      continue;
    }
    const data = doc.data();
    if (data.status !== 'scheduled') {
      continue;
    }
    for (const other of lessonOccurrenceIntervals(data, rangeStart, rangeEnd)) {
      if (Math.max(start, other.start) < Math.min(end, other.end)) {
        return true;
      }
    }
  }
  return false;
}

async function loadOwnedSeries(req, res) {
  const lessonRef = db.collection('lessons').doc(req.params.id);
  const lessonSnap = await lessonRef.get();
  if (!lessonSnap.exists || lessonSnap.data().tutor !== req.user.id) {
    res.status(404).json({ message: 'Lesson not found' });
    return null;
  }
  const existing = lessonSnap.data();
  if (!isRecurringSeries(existing) || !existing.rrule || !existing.scheduledAt) {
    res.status(400).json({ message: 'Lesson is not a recurring series' });
    return null;
  }
  return { lessonRef, existing };
}

/**
 * Перенос одного вхождения без выхода из серии: пишем occurrenceOverrides[occurrence_date].
 * Возврат вхождения на штатное время удаляет override.
 */
router.post('/:id/occurrence-move', async (req, res, next) => {
  try {
    const owned = await loadOwnedSeries(req, res);
    if (!owned) {
      return undefined;
    }
    const { lessonRef, existing } = owned;

    const occurrenceDate = normalizeOccurrenceDate(req.body.occurrence_date);
    if (!occurrenceDate) {
      return res.status(400).json({ message: 'occurrence_date is required' });
    }
    const nextAt = new Date(req.body.scheduledAt);
    if (Number.isNaN(nextAt.getTime())) {
      return res.status(400).json({ message: 'scheduledAt is invalid' });
    }

    const anchor = new Date(existing.scheduledAt);
    const overrides = normalizeOccurrenceOverrides(existing.occurrenceOverrides);
    const naturalAt = dateFromDayKey(occurrenceDate, anchor).toISOString();
    const previousAt = overrides[occurrenceDate]?.scheduledAt ?? naturalAt;

    if (scheduleTimesEqual(previousAt, nextAt.toISOString())) {
      return res.json(serializeDoc(await lessonRef.get()));
    }

    if (
      await slotHasCollision(req.user.id, {
        scheduledAt: nextAt.toISOString(),
        durationMinutes: existing.lesson_duration,
        excludeId: lessonRef.id,
      })
    ) {
      return res.status(409).json({ error: 'Time slot collision' });
    }

    if (scheduleTimesEqual(naturalAt, nextAt.toISOString())) {
      delete overrides[occurrenceDate];
    } else {
      overrides[occurrenceDate] = { scheduledAt: nextAt.toISOString() };
    }

    await lessonRef.update({
      occurrenceOverrides: overrides,
      reminder_sent: false,
      post_lesson_notified: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = serializeDoc(await lessonRef.get());
    if (!occurrenceIsMarked(existing, occurrenceDate)) {
      notifyLessonReschedule(
        req.user.id,
        { ...updated, scheduledAt: nextAt.toISOString() },
        existing.student_id,
        previousAt,
      ).catch((err) => console.error('notifyLessonReschedule:', err.message));
    }
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

/**
 * Перенос серии: `following` режет серию с этого вхождения, `all` — с первого будущего,
 * чтобы прошедшие занятия с их статусами и биллингом остались на прежних датах.
 */
router.post('/:id/series-move', async (req, res, next) => {
  try {
    const owned = await loadOwnedSeries(req, res);
    if (!owned) {
      return undefined;
    }
    const { lessonRef, existing } = owned;

    const occurrenceDate = normalizeOccurrenceDate(req.body.occurrence_date);
    if (!occurrenceDate) {
      return res.status(400).json({ message: 'occurrence_date is required' });
    }
    const dropAt = new Date(req.body.scheduledAt);
    if (Number.isNaN(dropAt.getTime())) {
      return res.status(400).json({ message: 'scheduledAt is invalid' });
    }
    const scope = req.body.scope === 'all' ? 'all' : 'following';

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let splitFromKey;
    if (scope === 'all') {
      const firstFuture = firstOccurrenceOnOrAfter(existing, today);
      splitFromKey = firstFuture ? dayKeyFromDate(firstFuture) : occurrenceDate;
      if (splitFromKey > occurrenceDate) {
        splitFromKey = occurrenceDate;
      }
    } else {
      const dropKey = dayKeyFromDate(dropAt);
      splitFromKey = dropKey < occurrenceDate ? dropKey : occurrenceDate;
    }

    const seriesStart = dateFromDayKey(existing.startDate ?? dayKeyFromDate(new Date(existing.scheduledAt)), null);
    const pastDates = occurrenceDatesBetween(
      existing,
      seriesStart,
      dateFromDayKey(shiftDayKey(splitFromKey, -1), null),
    );
    const originalCount = Number(parseRruleParts(existing.rrule).COUNT);
    const remainingCount = Number.isNaN(originalCount)
      ? null
      : Math.max(1, originalCount - pastDates.length);
    const nextRrule = withRruleTargetDay(
      existing.rrule,
      dropAt,
      remainingCount,
      dateFromDayKey(occurrenceDate, null),
    );

    // Для `all` серия начинается с первого будущего вхождения нового правила, для `following` — с точки drop.
    let nextAnchor = dropAt;
    if (scope === 'all') {
      const probeFrom = dateFromDayKey(splitFromKey, dropAt);
      const firstNew = firstOccurrenceOnOrAfter(
        {
          isRecurring: true,
          rrule: nextRrule,
          startDate: splitFromKey,
          scheduledAt: probeFrom.toISOString(),
        },
        probeFrom,
      );
      nextAnchor = firstNew ? applyAnchorTime(firstNew, dropAt) : dropAt;
    }

    // Страховка: перенос не должен оставить серию без вхождений (иначе уроки исчезнут из календаря).
    const movedPart = {
      isRecurring: true,
      rrule: nextRrule,
      startDate: dayKeyFromDate(nextAnchor),
      scheduledAt: nextAnchor.toISOString(),
    };
    console.log('[series-move]', {
      lessonId: lessonRef.id,
      scope,
      occurrenceDate,
      splitFromKey,
      pastCount: pastDates.length,
      fromRrule: existing.rrule,
      nextRrule,
      nextAnchor: nextAnchor.toISOString(),
      firstOfMovedPart: String(firstOccurrenceOnOrAfter(movedPart, nextAnchor)),
    });
    if (!firstOccurrenceOnOrAfter(movedPart, nextAnchor)) {
      return res.status(422).json({ message: 'Series move would leave no occurrences' });
    }

    if (
      await slotHasCollision(req.user.id, {
        scheduledAt: nextAnchor.toISOString(),
        durationMinutes: existing.lesson_duration,
        excludeId: lessonRef.id,
      })
    ) {
      return res.status(409).json({ error: 'Time slot collision' });
    }

    const overrides = normalizeOccurrenceOverrides(existing.occurrenceOverrides);
    const pastOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key < splitFromKey),
    );
    const previousAt = overrides[occurrenceDate]?.scheduledAt
      ?? dateFromDayKey(occurrenceDate, new Date(existing.scheduledAt)).toISOString();

    const batch = db.batch();
    let createdRef = null;

    if (pastDates.length === 0) {
      // Прошедших вхождений нет — переписываем серию на месте.
      batch.update(lessonRef, {
        scheduledAt: nextAnchor.toISOString(),
        startDate: dayKeyFromDate(nextAnchor),
        rrule: nextRrule,
        isRecurring: true,
        occurrenceOverrides: pastOverrides,
        reminder_sent: false,
        post_lesson_notified: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      batch.update(lessonRef, {
        rrule: withRruleUntil(existing.rrule, shiftDayKey(splitFromKey, -1)),
        occurrenceOverrides: pastOverrides,
        updatedAt: FieldValue.serverTimestamp(),
      });
      createdRef = db.collection('lessons').doc();
      batch.set(createdRef, {
        tutor: existing.tutor,
        student_id: existing.student_id ?? null,
        student_name: existing.student_name ?? null,
        lesson_price: existing.lesson_price ?? 0,
        lesson_currency: existing.lesson_currency ?? 'EUR',
        price_mode: existing.price_mode ?? 'hourly',
        student_timezone: existing.student_timezone ?? 'UTC',
        lesson_duration: existing.lesson_duration ?? 60,
        status: 'scheduled',
        title: existing.title ?? '',
        notes: existing.notes ?? '',
        memo: existing.memo ?? '',
        scheduledAt: nextAnchor.toISOString(),
        isRecurring: true,
        startDate: dayKeyFromDate(nextAnchor),
        rrule: nextRrule,
        exdates: [],
        completedDates: [],
        missedDates: [],
        canceledDates: [],
        occurrenceOverrides: {},
        reminder_sent: false,
        post_lesson_notified: false,
        balance_debited: false,
        billing_processed: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    const master = serializeDoc(await lessonRef.get());
    const created = createdRef ? serializeDoc(await createdRef.get()) : null;

    notifyLessonReschedule(
      req.user.id,
      created ?? master,
      existing.student_id,
      previousAt,
    ).catch((err) => console.error('notifyLessonReschedule:', err.message));

    return res.json({ master, created });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/cancel-with-billing', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const { status, should_deduct_balance, student_id } = req.body;
    if (!status || !isMissedOrCanceledStatus(status)) {
      return res.status(400).json({ message: 'status must be missed or canceled' });
    }
    const result = await cancelLessonWithBilling({
      tutorId,
      lessonId: req.params.id,
      studentId: student_id,
      nextStatus: status,
      shouldDeduct: should_deduct_balance === true,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const lessonRef = db.collection('lessons').doc(req.params.id);
    const lessonSnap = await lessonRef.get();
    if (!lessonSnap.exists || lessonSnap.data().tutor !== tutorId) {
      return res.status(404).json({ message: 'Lesson not found' });
    }

    const existing = lessonSnap.data();
    const scope = String(req.query.scope ?? req.body?.scope ?? 'series').toLowerCase();
    const occurrenceDate = normalizeOccurrenceDate(
      req.query.occurrence_date ?? req.body?.occurrence_date,
    );

    if (isRecurringSeries(existing) && scope === 'occurrence') {
      if (!occurrenceDate) {
        return res.status(400).json({ message: 'occurrence_date is required for occurrence delete' });
      }
      await excludeRecurringOccurrence({ tutorId, lessonRef, existing, occurrenceDate });
      const updatedSnap = await lessonRef.get();
      return res.json(serializeDoc(updatedSnap));
    }

    const batch = db.batch();
    batch.delete(lessonRef);

    if (existing.student_id && existing.balance_debited) {
      const studentRef = db.collection('students').doc(existing.student_id);
      const studentSnap = await studentRef.get();
      if (studentSnap.exists && studentSnap.data().tutor_id === tutorId) {
        const units =
          existing.balance_units_debited != null && Number(existing.balance_units_debited) > 0
            ? Math.round(Number(existing.balance_units_debited) * 100) / 100
            : 1;
        batch.update(studentRef, {
          balance_lessons: FieldValue.increment(units),
          updatedAt: FieldValue.serverTimestamp(),
        });
        appendBalanceLog(batch, {
          tutorId,
          studentId: existing.student_id,
          studentName: studentSnap.data().name,
          lessonId: lessonRef.id,
          amount: units,
          reason: 'lesson_deleted_refund',
        });
      }
    }

    await batch.commit();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
