const { db } = require('../firebase');

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

    if (req.method === 'PUT' && req.params.id) {
      const scheduleTouched =
        Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt') ||
        Object.prototype.hasOwnProperty.call(req.body, 'lesson_duration');
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
    }

    const effectiveStatus = status === undefined ? 'scheduled' : status;
    if (effectiveStatus !== 'scheduled') {
      return next();
    }

    const candidate = intervalBounds(scheduledAt, lessonDuration);
    if (!candidate) {
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
      const other = intervalBounds(data.scheduledAt, data.lesson_duration);
      if (!other) {
        continue;
      }
      if (intervalsOverlap(candidate.start, candidate.end, other.start, other.end)) {
        return res.status(409).json({ error: 'Time slot collision' });
      }
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = checkLessonCollision;
