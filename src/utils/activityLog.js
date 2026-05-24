const { db, FieldValue } = require('../firebase');
const { serializeQuerySnapshot } = require('./serialize');

const STUDENT_LOG_FIELDS = [
  'name',
  'rate_per_hour',
  'rate_currency',
  'timezone',
  'bot_active',
  'balance_lessons',
  'billing_type',
  'credit_limit',
  'auto_debit_enabled',
  'color_hex',
];

function valuesEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (left == null && right == null) {
    return true;
  }
  return false;
}

function collectChanges(before, after, fields = STUDENT_LOG_FIELDS) {
  const changes = [];
  for (const field of fields) {
    const from = before?.[field];
    const to = after?.[field];
    if (!valuesEqual(from, to)) {
      changes.push({ field, from: from ?? null, to: to ?? null });
    }
  }
  return changes;
}

function collectPatchChanges(before, patch, fields = STUDENT_LOG_FIELDS) {
  const after = { ...before, ...patch };
  const touched = fields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
  return collectChanges(before, after, touched.length ? touched : fields);
}

function appendStudentBalanceLog(writer, { tutorId, studentId, studentName, amount, reason, lessonId }) {
  const action = amount < 0 ? 'balance.debit' : 'balance.credit';
  const ref = db.collection('activity_logs').doc();
  writer.set(ref, {
    tutor_id: tutorId,
    category: 'students',
    action,
    entity_type: 'student',
    entity_id: studentId ?? null,
    summary: reason,
    changes: [{ field: 'balance_lessons', from: null, to: amount }],
    metadata: { amount, reason, lessonId: lessonId ?? null },
    student_name: studentName ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function appendActivityLog(writer, payload) {
  const ref = db.collection('activity_logs').doc();
  writer.set(ref, {
    tutor_id: payload.tutorId,
    category: payload.category,
    action: payload.action,
    entity_type: payload.entityType,
    entity_id: payload.entityId ?? null,
    summary: payload.summary ?? '',
    changes: payload.changes ?? [],
    metadata: payload.metadata ?? {},
    student_name: payload.studentName ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function writeActivityLog(payload) {
  await db.collection('activity_logs').add({
    tutor_id: payload.tutorId,
    category: payload.category,
    action: payload.action,
    entity_type: payload.entityType,
    entity_id: payload.entityId ?? null,
    summary: payload.summary ?? '',
    changes: payload.changes ?? [],
    metadata: payload.metadata ?? {},
    student_name: payload.studentName ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function listActivityLogs({ tutorId, category, limit = 50 }) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const snap = await db.collection('activity_logs').where('tutor_id', '==', tutorId).limit(500).get();
  return serializeQuerySnapshot(snap)
    .filter((row) => row.category === category)
    .sort((left, right) => {
      const leftMs = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightMs = right.createdAt ? Date.parse(right.createdAt) : 0;
      return rightMs - leftMs;
    })
    .slice(0, capped);
}

module.exports = {
  STUDENT_LOG_FIELDS,
  collectChanges,
  collectPatchChanges,
  appendActivityLog,
  writeActivityLog,
  listActivityLogs,
  appendStudentBalanceLog,
};
