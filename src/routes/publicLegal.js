const express = require('express');
const { db } = require('../firebase');
const {
  LEGAL_DOC_IDS,
  isLegalDocId,
  defaultLegalDoc,
} = require('../utils/legalContent');

const router = express.Router();

function contactEmail() {
  const fromEnv = String(process.env.CONTACT_EMAIL || '').trim();
  return fromEnv || 'support@simple4u.com';
}

/** GET /api/public/legal/:doc — datenschutz | impressum */
router.get('/legal/:doc', async (req, res, next) => {
  try {
    const docId = String(req.params.doc || '').trim();
    if (!isLegalDocId(docId)) {
      return res.status(404).json({ message: 'Not found', code: 'UNKNOWN_LEGAL_DOC' });
    }

    const snap = await db.collection('site_content').doc(`legal_${docId}`).get();
    if (snap.exists) {
      const data = snap.data() || {};
      return res.json({
        id: docId,
        title: String(data.title || defaultLegalDoc(docId).title),
        body: String(data.body || defaultLegalDoc(docId).body),
        updatedAt: data.updatedAt ?? null,
        source: 'firestore',
      });
    }

    const fallback = defaultLegalDoc(docId);
    return res.json({
      id: docId,
      title: fallback.title,
      body: fallback.body,
      updatedAt: null,
      source: 'default',
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/public/contact */
router.get('/contact', (_req, res) => {
  res.json({ email: contactEmail() });
});

/** GET /api/public/legal — list ids */
router.get('/legal', (_req, res) => {
  res.json({ docs: [...LEGAL_DOC_IDS] });
});

module.exports = router;
