/** Приводит документ Firestore к JSON с полем _id (как у Mongoose). */
function serializeDoc(doc) {
  if (!doc.exists) {
    return null;
  }
  const data = doc.data();
  const out = { _id: doc.id };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v.toDate === 'function') {
      out[k] = v.toDate().toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Сериализация query snapshot → массив объектов с _id. */
function serializeQuerySnapshot(snap) {
  return snap.docs.map((d) => serializeDoc(d));
}

module.exports = { serializeDoc, serializeQuerySnapshot };
