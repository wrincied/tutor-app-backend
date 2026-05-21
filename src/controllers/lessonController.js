/**
 * Legacy-контроллер (не подключён в server.js; актуальная логика — src/routes/lessons.js).
 * Снапшот ставки только из профиля ученика, без lesson_price с клиента.
 */
const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');
const { studentSnapshotFromStudent } = require('../utils/lessonSnapshot');

const ALLOWED_STATUS = ['scheduled', 'completed', 'cancelled', 'canceled', 'missed'];

function parseLessonDuration(raw) {
  const n = Number(raw);
  if (Number.isNaN(n) || n < 5) {
    return 60;
  }
  return Math.min(480, Math.round(n));
}

async function ensureStudent(studentId, tutorId) {
  if (!studentId) {
    return null;
  }
  const stu = await db.collection('students').doc(studentId).get();
  if (!stu.exists || stu.data().tutor_id !== tutorId) {
    return null;
  }
  return stu.data();
}

exports.create = async (req, res) => {
  const { student_id, status, title, notes, scheduledAt, lesson_duration } = req.body;

  if (
    Object.prototype.hasOwnProperty.call(req.body, 'lesson_price') ||
    Object.prototype.hasOwnProperty.call(req.body, 'lesson_currency')
  ) {
    return res.status(400).json({
      message: 'lesson_price and lesson_currency are snapshot fields and cannot be set directly',
    });
  }

  if (!student_id) {
    return res.status(400).json({ message: 'student_id is required' });
  }

  const studentData = await ensureStudent(student_id, req.user.id);
  if (!studentData) {
    return res.status(400).json({ message: 'Ученик не найден' });
  }

  const snapshot = studentSnapshotFromStudent(studentData);
  const st = typeof status === 'string' && ALLOWED_STATUS.includes(status) ? status : 'scheduled';
  const durationMin = parseLessonDuration(lesson_duration);

  const docRef = await db.collection('lessons').add({
    tutor: req.user.id,
    student_id,
    student_name: studentData.name || null,
    lesson_price: snapshot.lesson_price,
    lesson_currency: snapshot.lesson_currency,
    student_timezone: snapshot.student_timezone,
    lesson_duration: durationMin,
    status: st,
    title: title || '',
    notes: notes || '',
    scheduledAt: scheduledAt || null,
    reminder_sent: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const created = await docRef.get();
  res.status(201).json(serializeDoc(created));
};

exports.update = async (req, res) => {
  const { id } = req.params;
  const ref = db.collection('lessons').doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().tutor !== req.user.id) {
    return res.status(404).json({ message: 'Урок не найден' });
  }

  if (
    Object.prototype.hasOwnProperty.call(req.body, 'lesson_price') ||
    Object.prototype.hasOwnProperty.call(req.body, 'lesson_currency')
  ) {
    return res.status(400).json({
      message: 'lesson_price and lesson_currency are snapshot fields and cannot be set directly',
    });
  }

  const existing = snap.data();
  const { student_id, status, title, notes, scheduledAt, lesson_duration } = req.body;

  const st =
    typeof status === 'string' && ALLOWED_STATUS.includes(status) ? status : existing.status;

  const durationMin =
    lesson_duration !== undefined && lesson_duration !== null
      ? parseLessonDuration(lesson_duration)
      : existing.lesson_duration ?? 60;

  const patch = {
    lesson_duration: durationMin,
    status: st,
    title: title != null ? String(title) : '',
    notes: notes != null ? String(notes) : '',
    scheduledAt: scheduledAt != null && scheduledAt !== '' ? scheduledAt : null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (Object.prototype.hasOwnProperty.call(req.body, 'student_id')) {
    const newStudentId = student_id || null;
    const studentData = await ensureStudent(newStudentId, req.user.id);
    if (newStudentId && !studentData) {
      return res.status(400).json({ message: 'Ученик не найден' });
    }
    patch.student_id = newStudentId;
    patch.student_name = studentData?.name || null;
    if (newStudentId !== (existing.student_id ?? null) && studentData) {
      Object.assign(patch, studentSnapshotFromStudent(studentData));
    }
  }

  await ref.update(patch);
  const updated = await ref.get();
  res.json(serializeDoc(updated));
};

exports.remove = async (req, res) => {
  const { id } = req.params;
  const ref = db.collection('lessons').doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().tutor !== req.user.id) {
    return res.status(404).json({ message: 'Урок не найден' });
  }
  await ref.delete();
  res.status(204).send();
};

exports.list = async (req, res) => {
  const snap = await db.collection('lessons').where('tutor', '==', req.user.id).get();
  const list = snap.docs.map((d) => serializeDoc(d));
  list.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json(list);
};
