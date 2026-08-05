/**
 * Push DEFAULT_LEGAL markdown into Firestore CMS docs.
 *
 * Usage:
 *   node scripts/sync-legal-defaults.js              # all docs
 *   node scripts/sync-legal-defaults.js datenschutz  # one doc
 *
 * Requires Firebase Admin credentials via backend/.env (same as other scripts).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, FieldValue } = require('../src/firebase');
const {
  LEGAL_DOC_IDS,
  isLegalDocId,
  defaultLegalDoc,
} = require('../src/utils/legalContent');

async function syncOne(docId) {
  const fallback = defaultLegalDoc(docId);
  const ref = db.collection('site_content').doc(`legal_${docId}`);
  await ref.set(
    {
      title: fallback.title,
      body: fallback.body,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'sync-legal-defaults',
    },
    { merge: true },
  );
  console.log(`Synced legal_${docId} (${fallback.body.length} chars)`);
}

async function main() {
  const only = String(process.argv[2] || '').trim();
  const ids = only ? [only] : [...LEGAL_DOC_IDS];
  for (const id of ids) {
    if (!isLegalDocId(id)) {
      console.error(`Unknown legal doc: ${id}`);
      process.exit(1);
    }
    await syncOne(id);
  }
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
