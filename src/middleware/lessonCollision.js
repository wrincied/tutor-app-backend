const { db } = require('../firebase');
const { lessonOccurrenceIntervals } = require('../utils/lessonRecurrence');

function clampDuration(raw) {
  const minutes = Number(raw);
  if (Number.isNaN(minutes)) {
    return 60;
  }
  return Math.min(480, Math.max(5, Math.round(minutes)));
}

function intervalBounds(scheduledAt, durationMinutes) {
  if (!scheduledAt) {
    return null;
  }
  const start = Date.parse(String(scheduledAt));
  if (Number.isNaN(start)) {
    return null;
  }
  const duration = clampDuration(durationMinutes);
  const end = start + duration * 60000;
  return { start, end };
}

function intervalsOverlap(startA, endA, startB, endB) {
  return Math.max(startA, startB) < Math.min(endA, endB);
}

function collisionRangeAround(scheduledAt) {
  const anchor = new Date(scheduledAt);
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 7);
  const end = new Date(anchor);
  end.setHours(23, 59, 59, 999);
  end.setDate(end.getDate() + 7 * 26);
  return { start, end };
}

/**
 * POST / PUT: 409 if a scheduled lesson overlaps another scheduled lesson of the same tutor.
 */
async function checkLessonCollision(req, res, next) {
  try {
    const tutorId = req.user.id;
    let status = req.body.status;
    let scheduledAt = req.body.scheduledAt;
    let lessonDuration = req.body.lesson_duration;
    let excludeId = null;
    let candidateRecurrence = {
      isRecurring: req.body.isRecurring === true,
      rrule: req.body.rrule ?? null,
      startDate: req.body.startDate ?? null,
    };

    if (req.method === 'PUT' && req.params.id) {
      const scheduleTouched =
        Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt') ||
        Object.prototype.hasOwnProperty.call(req.body, 'lesson_duration') ||
        Object.prototype.hasOwnProperty.call(req.body, 'isRecurring') ||
        Object.prototype.hasOwnProperty.call(req.body, 'rrule') ||
        Object.prototype.hasOwnProperty.call(req.body, 'startDate');
      if (!scheduleTouched) {
        return next();
      }

      excludeId = req.params.id;
      const lessonSnap = await db.collection('lessons').doc(excludeId).get();
      if (!lessonSnap.exists || lessonSnap.data().tutor !== tutorId) {
        return next();
      }
      const existing = lessonSnap.data();
      if (status === undefined) {
        status = existing.status;
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt')) {
        scheduledAt = existing.scheduledAt;
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, 'lesson_duration')) {
        lessonDuration = existing.lesson_duration;
      }
      candidateRecurrence = {
        isRecurring: Object.prototype.hasOwnProperty.call(req.body, 'isRecurring')
          ? req.body.isRecurring === true
          : existing.isRecurring === true,
        rrule: Object.prototype.hasOwnProperty.call(req.body, 'rrule')
          ? req.body.rrule
          : existing.rrule,
        startDate: Object.prototype.hasOwnProperty.call(req.body, 'startDate')
          ? req.body.startDate
          : existing.startDate,
      };
    }

    const effectiveStatus = status === undefined ? 'scheduled' : status;
    if (effectiveStatus !== 'scheduled') {
      return next();
    }

    if (!scheduledAt) {
      return next();
    }

    const range = collisionRangeAround(scheduledAt);
    const candidateLesson = {
      scheduledAt,
      lesson_duration: lessonDuration,
      ...candidateRecurrence,
    };

    const candidateIntervals = lessonOccurrenceIntervals(candidateLesson, range.start, range.end);
    if (candidateIntervals.length === 0) {
      return next();
    }

    const snap = await db.collection('lessons').where('tutor', '==', tutorId).get();

    for (const doc of snap.docs) {
      if (excludeId && doc.id === excludeId) {
        continue;
      }
      const data = doc.data();
      if (data.status !== 'scheduled') {
        continue;
      }
      const otherIntervals = lessonOccurrenceIntervals(data, range.start, range.end);
      for (const candidate of candidateIntervals) {
        for (const other of otherIntervals) {
          if (intervalsOverlap(candidate.start, candidate.end, other.start, other.end)) {
            return res.status(409).json({ error: 'Time slot collision' });
          }
        }
      }
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = checkLessonCollision;
