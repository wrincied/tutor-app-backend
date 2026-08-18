function eventDocId(source, eventId) {
  const id = `${String(source || '').trim()}_${String(eventId || '').trim()}`;
  return id.slice(0, 700);
}

/**
 * Claim a webhook event so retries do not re-apply entitlements.
 * Returns 'duplicate' when already applied, otherwise 'process'.
 */
async function beginWebhookEvent(db, FieldValue, source, eventId) {
  const rawId = String(eventId || '').trim();
  if (!rawId) {
    return 'process';
  }
  const ref = db.collection('webhook_events').doc(eventDocId(source, rawId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.status === 'applied') {
      return 'duplicate';
    }
    if (!snap.exists) {
      tx.set(ref, {
        source,
        eventId: rawId,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    return 'process';
  });
}

async function completeWebhookEvent(db, FieldValue, source, eventId) {
  const rawId = String(eventId || '').trim();
  if (!rawId) {
    return;
  }
  await db.collection('webhook_events').doc(eventDocId(source, rawId)).set(
    {
      source,
      eventId: rawId,
      status: 'applied',
      appliedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

module.exports = {
  eventDocId,
  beginWebhookEvent,
  completeWebhookEvent,
};
