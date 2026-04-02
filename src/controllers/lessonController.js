const { db, FieldValue } = require('../firebase');
const { serializeDoc } = require('../utils/serialize');

const ALLOWED_STATUS = ['scheduled', 'completed', 'cancelled'];

/** Длительность урока в минутах: 5–480, иначе 60. */
function parseLessonDuration(raw) {
  const n = Number(raw);
  if (Number.isNaN(n) || n < 5) {
    return 60;
  }
  return Math.min(480, Math.round(n));
}

/** POST /api/lessons — сохранение урока в коллекцию lessons (поля согласованы с /api/finance/summary). */
exports.create = async (req, res) => {
  const { student_id, lesson_price, status, title, notes, scheduledAt, lesson_duration } = req.body;

  const price = lesson_price !== undefined && lesson_price !== null ? Number(lesson_price) : NaN;
  if (Number.isNaN(price) || price < 0) {
    return res.status(400).json({ message: 'Укажите неотрицательное число lesson_price' });
  }

  const st = typeof status === 'string' && ALLOWED_STATUS.includes(status) ? status : 'scheduled';
  const durationMin = parseLessonDuration(lesson_duration);

  if (student_id) {
    const stu = await db.collection('students').doc(student_id).get();
    if (!stu.exists || stu.data().tutor_id !== req.user.id) {
      return res.status(400).json({ message: 'Ученик не найден' });
    }
  }

  const docRef = await db.collection('lessons').add({
    tutor: req.user.id,
    student_id: student_id || null,
    lesson_price: price,
    lesson_duration: durationMin,
    status: st,
    title: title || '',
    notes: notes || '',
    scheduledAt: scheduledAt || null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const created = await docRef.get();
  res.status(201).json(serializeDoc(created));
};

/** PUT /api/lessons/:id — обновление урока */
exports.update = async (req, res) => {
  const { id } = req.params;
  const ref = db.collection('lessons').doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().tutor !== req.user.id) {
    return res.status(404).json({ message: 'Урок не найден' });
  }

  const { student_id, lesson_price, status, title, notes, scheduledAt, lesson_duration } = req.body;

  const price = lesson_price !== undefined && lesson_price !== null ? Number(lesson_price) : NaN;
  if (Number.isNaN(price) || price < 0) {
    return res.status(400).json({ message: 'Укажите неотрицательное число lesson_price' });
  }

  const st =
    typeof status === 'string' && ALLOWED_STATUS.includes(status) ? status : snap.data().status;

  const durationMin =
    lesson_duration !== undefined && lesson_duration !== null
      ? parseLessonDuration(lesson_duration)
      : snap.data().lesson_duration ?? 60;

  if (student_id) {
    const stu = await db.collection('students').doc(student_id).get();
    if (!stu.exists || stu.data().tutor_id !== req.user.id) {
      return res.status(400).json({ message: 'Ученик не найден' });
    }
  }

  await ref.update({
    student_id: student_id != null ? student_id : null,
    lesson_price: price,
    lesson_duration: durationMin,
    status: st,
    title: title != null ? String(title) : '',
    notes: notes != null ? String(notes) : '',
    scheduledAt: scheduledAt != null && scheduledAt !== '' ? scheduledAt : null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await ref.get();
  res.json(serializeDoc(updated));
};

/** DELETE /api/lessons/:id */
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

/** GET /api/lessons — список уроков репетитора */
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
