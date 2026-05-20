const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const checkLessonCollision = require('../middleware/lessonCollision');
const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');

const ALLOWED_STATUS = new Set(['scheduled', 'completed', 'missed', 'canceled', 'cancelled']);
const ALLOWED_CURRENCY = new Set(['BYN', 'PLN', 'EUR', 'USD', 'RUB']);

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

router.get('/', async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const snap = await db.collection('lessons').where('tutor', '==', tutorId).get();
    const lessons = serializeQuerySnapshot(snap);
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

    const studentData = await ensureStudentOwned(normalizedStudentId, tutorId);
    if (!studentData) {
      return res.status(400).json({ message: 'Student not found' });
    }

    const ratePerHour = Number(studentData.rate_per_hour);
    if (Number.isNaN(ratePerHour) || ratePerHour < 0) {
      return res.status(400).json({ message: 'Student rate_per_hour is invalid' });
    }

    const normalizedStatus = ALLOWED_STATUS.has(status) ? status : 'scheduled';
    const normalizedDuration = clampDuration(lesson_duration);
    const currencySnapshot = ALLOWED_CURRENCY.has(studentData.rate_currency)
      ? studentData.rate_currency
      : 'EUR';

    const createdRef = await db.collection('lessons').add({
      tutor: tutorId,
      student_id: normalizedStudentId,
      student_name: studentData.name || null,
      lesson_price: ratePerHour,
      lesson_currency: currencySnapshot,
      lesson_duration: normalizedDuration,
      status: normalizedStatus,
      title: title ? String(title).trim() : '',
      notes: notes ? String(notes).trim() : '',
      scheduledAt: scheduledAt ? String(scheduledAt) : null,
      reminder_sent: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

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

    const hasStudentField = Object.prototype.hasOwnProperty.call(req.body, 'student_id');
    if (hasStudentField) {
      const normalizedStudentId = student_id || null;
      const studentData = await ensureStudentOwned(normalizedStudentId, tutorId);
      if (normalizedStudentId && !studentData) {
        return res.status(400).json({ message: 'Student not found' });
      }
      patch.student_id = normalizedStudentId;
      patch.student_name = studentData?.name || null;
    }

    if (lesson_duration !== undefined) {
      patch.lesson_duration = clampDuration(lesson_duration);
    }
    if (status !== undefined) {
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

    const scheduleChanged = Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt');
    const durationChanged = Object.prototype.hasOwnProperty.call(req.body, 'lesson_duration');
    if (scheduleChanged || durationChanged) {
      patch.reminder_sent = false;
    }

    await lessonRef.update(patch);
    const updatedSnap = await lessonRef.get();
    res.json(serializeDoc(updatedSnap));
  } catch (error) {
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

    await lessonRef.delete();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
