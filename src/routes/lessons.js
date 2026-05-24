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
} = require('../utils/lessonSnapshot');
const {
  applyLessonStatusBilling,
  applyLessonBalanceOnCreate,
  appendBalanceLog,
  isCompletedStatus,
  isMissedOrCanceledStatus,
  cancelLessonWithBilling,
} = require('../services/lessonBilling');
const { normalizeRecurrenceFields, dayKeyFromDate } = require('../utils/lessonRecurrence');
const {
  normalizeOccurrenceDate,
  applyRecurringOccurrenceStatus,
  excludeRecurringOccurrence,
} = require('../services/lessonOccurrence');

const ALLOWED_STATUS = new Set(['scheduled', 'completed', 'missed', 'canceled', 'cancelled']);

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

router.use(auth);
router.use(requireVerifiedEmail);

router.get('/', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const [lessonsSnap, studentsSnap] = await Promise.all([
      db.collection('lessons').where('tutor', '==', tutorId).get(),
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
    lessons.sort((left, right) => {
      const l = left.scheduledAt ? Date.parse(left.scheduledAt) : 0;
      const r = right.scheduledAt ? Date.parse(right.scheduledAt) : 0;
      return r - l;
    });
    res.json(lessons);
  } catch (error) {
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
      scheduledAt,
    } = req.body;

    const normalizedStudentId = student_id || null;
    if (!normalizedStudentId) {
      return res.status(400).json({ message: 'student_id is required' });
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_price') ||
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_currency')
    ) {
      return res.status(400).json({
        message: 'lesson_price and lesson_currency are snapshot fields and cannot be set directly',
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
      student_timezone: snapshot.student_timezone,
      lesson_duration: normalizedDuration,
      status: normalizedStatus,
      title: title ? String(title).trim() : '',
      notes: notes ? String(notes).trim() : '',
      scheduledAt: scheduledAt ? String(scheduledAt) : null,
      isRecurring: recurrence.isRecurring,
      startDate: recurrence.startDate,
      rrule: recurrence.rrule,
      exdates: [],
      completedDates: [],
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
        shouldDeduct: shouldDeductOnCreate,
        autoDebitEnabled: studentData.auto_debit_enabled !== false,
        manualCompletion: req.body.manual_completion !== false,
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
    if (occurrenceStatusRaw === undefined && seriesRecurring && occurrenceDate) {
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
      const manualCompletion = req.body.manual_completion !== false;
      await applyRecurringOccurrenceStatus({
        tutorId,
        lessonRef,
        existing,
        occurrenceDate,
        nextStatus: occurrenceStatusRaw,
        shouldDeduct: req.body.should_deduct_balance === true,
        autoDebitEnabled: studentSnap.data().auto_debit_enabled !== false,
        studentSnap,
        studentRef,
        billImmediately: manualCompletion,
      });
    }

    const {
      student_id,
      lesson_duration,
      status,
      title,
      notes,
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
          patch.student_timezone = 'UTC';
        }
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_price') ||
      Object.prototype.hasOwnProperty.call(req.body, 'lesson_currency')
    ) {
      return res.status(400).json({
        message: 'lesson_price and lesson_currency are snapshot fields and cannot be set directly',
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
    if (Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt')) {
      patch.scheduledAt = scheduledAt ? String(scheduledAt) : null;
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body, 'isRecurring') ||
      Object.prototype.hasOwnProperty.call(req.body, 'rrule') ||
      Object.prototype.hasOwnProperty.call(req.body, 'startDate')
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
        patch.exdates = [];
        patch.completedDates = [];
      }
    }

    const scheduleChanged = Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt');
    const durationChanged = Object.prototype.hasOwnProperty.call(req.body, 'lesson_duration');
    if (scheduleChanged || durationChanged) {
      patch.reminder_sent = false;
    }

    const nextStatus = patch.status ?? existing.status;
    const studentIdForBalance = patch.student_id ?? existing.student_id;

    const batch = db.batch();
    batch.update(lessonRef, patch);

    if (!seriesRecurring) {
      const statusChangingToMissedCanceled =
        status !== undefined &&
        isMissedOrCanceledStatus(nextStatus) &&
        !isMissedOrCanceledStatus(existing.status);

      if (
        statusChangingToMissedCanceled &&
        !Object.prototype.hasOwnProperty.call(req.body, 'should_deduct_balance')
      ) {
        return res.status(400).json({
          message: 'should_deduct_balance is required when status is missed or canceled',
        });
      }

      const shouldDeduct = req.body.should_deduct_balance === true;

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
        applyLessonStatusBilling(batch, {
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
          shouldDeduct,
          autoDebitEnabled: studentSnap.data().auto_debit_enabled !== false,
          manualCompletion: req.body.manual_completion !== false,
        });
      }
    }

    await batch.commit();

    const updatedSnap = await lessonRef.get();
    res.json(serializeDoc(updatedSnap));
  } catch (error) {
    next(error);
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
        batch.update(studentRef, {
          balance_lessons: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        appendBalanceLog(batch, {
          tutorId,
          studentId: existing.student_id,
          studentName: studentSnap.data().name,
          lessonId: lessonRef.id,
          amount: 1,
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
