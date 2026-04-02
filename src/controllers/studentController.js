const { db, FieldValue } = require('../firebase');
const { serializeDoc, serializeQuerySnapshot } = require('../utils/serialize');

// GET /api/students
exports.getAll = async (req, res) => {
  const snap = await db.collection('students').where('tutor_id', '==', req.user.id).get();
  const list = serializeQuerySnapshot(snap);
  list.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json(list);
};

// GET /api/students/:id
exports.getOne = async (req, res) => {
  const doc = await db.collection('students').doc(req.params.id).get();
  if (!doc.exists) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }
  const data = doc.data();
  if (data.tutor_id !== req.user.id) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }
  res.json(serializeDoc(doc));
};

// POST /api/students
exports.create = async (req, res) => {
  const { name, rate_per_hour, rate_currency, timezone } = req.body;
  const allowed = ['BYN', 'PLN', 'EUR', 'USD', 'RUB'];
  const cur = allowed.includes(rate_currency) ? rate_currency : 'EUR';

  const docRef = await db.collection('students').add({
    tutor_id: req.user.id,
    name,
    rate_per_hour,
    rate_currency: cur,
    balance_lessons: 0,
    auto_debit_enabled: true,
    bot_active: false,
    timezone: timezone || 'Europe/Moscow',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const created = await docRef.get();
  res.status(201).json(serializeDoc(created));
};

// PUT /api/students/:id
exports.update = async (req, res) => {
  const { name, rate_per_hour, rate_currency, timezone, auto_debit_enabled } = req.body;
  const allowed = ['BYN', 'PLN', 'EUR', 'USD', 'RUB'];
  const ref = db.collection('students').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }
  if (snap.data().tutor_id !== req.user.id) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }

  const patch = { updatedAt: FieldValue.serverTimestamp() };
  if (name !== undefined) patch.name = name;
  if (rate_per_hour !== undefined) patch.rate_per_hour = rate_per_hour;
  if (timezone !== undefined) patch.timezone = timezone;
  if (auto_debit_enabled !== undefined) patch.auto_debit_enabled = auto_debit_enabled;
  if (rate_currency !== undefined) {
    patch.rate_currency = allowed.includes(rate_currency) ? rate_currency : 'EUR';
  }

  await ref.update(patch);
  const updated = await ref.get();
  res.json(serializeDoc(updated));
};

// DELETE /api/students/:id
exports.remove = async (req, res) => {
  const ref = db.collection('students').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }
  if (snap.data().tutor_id !== req.user.id) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }
  await ref.delete();
  res.json({ message: 'Удалён' });
};

// POST /api/students/:id/topup
exports.topup = async (req, res) => {
  const { lessons } = req.body;
  if (!lessons || lessons < 1) {
    return res.status(400).json({ message: 'Укажите количество уроков' });
  }
  const ref = db.collection('students').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }
  if (snap.data().tutor_id !== req.user.id) {
    return res.status(404).json({ message: 'Ученик не найден' });
  }

  await ref.update({
    balance_lessons: FieldValue.increment(lessons),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const after = await ref.get();
  res.json(serializeDoc(after));
};
