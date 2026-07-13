/**
 * Список / удаление уроков без scheduledAt (фантомы в финансах).
 * Usage:
 *   node scripts/cleanup-lessons-without-schedule.js
 *   node scripts/cleanup-lessons-without-schedule.js --student=Arsen
 *   node scripts/cleanup-lessons-without-schedule.js --student=Arsen --delete
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { db } = require('../src/firebase');

function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return hit ? hit.slice(prefix.length + 1) : '';
}

async function main() {
  const deleteMode = process.argv.includes('--delete');
  const studentFilter = argValue('--student').trim().toLowerCase();
  const idFilter = argValue('--id').trim();

  const snap = await db.collection('lessons').get();
  const targets = [];

  snap.forEach((doc) => {
    const data = doc.data();
    if (idFilter && doc.id !== idFilter) {
      return;
    }
    if (!idFilter && data.scheduledAt) {
      return;
    }
    const studentName = String(data.student_name ?? '');
    if (studentFilter && !studentName.toLowerCase().includes(studentFilter)) {
      return;
    }
    targets.push({
      id: doc.id,
      tutor: data.tutor,
      student_name: studentName,
      student_id: data.student_id ?? null,
      status: data.status ?? null,
      lesson_duration: data.lesson_duration ?? null,
      scheduledAt: data.scheduledAt ?? null,
      createdAt: data.createdAt?.toDate?.()
        ? data.createdAt.toDate().toISOString()
        : data.createdAt ?? null,
      isRecurring: Boolean(data.isRecurring || data.rrule),
    });
  });

  if (targets.length === 0) {
    console.log('No matching lessons found.');
    return;
  }

  console.log(JSON.stringify(targets, null, 2));

  if (!deleteMode) {
    console.log(`\n${targets.length} lesson(s). Re-run with --delete to remove.`);
    return;
  }

  const batch = db.batch();
  for (const row of targets) {
    batch.delete(db.collection('lessons').doc(row.id));
  }
  await batch.commit();
  console.log(`\nDeleted ${targets.length} lesson(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
