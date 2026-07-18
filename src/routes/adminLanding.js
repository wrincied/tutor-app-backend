const {
  isLegalDocId,
  sanitizeLegalMarkdown,
  sanitizeLegalTitle,
  defaultLegalDoc,
  LEGAL_DOC_IDS,
} = require('../utils/legalContent');
const { db, FieldValue } = require('../firebase');

/**
 * Mount on admin router after auth + requireSuperAdmin.
 * GET/PUT /landing/legal/:doc
 * GET /landing/legal
 */
function registerLandingAdminRoutes(router) {
  router.get('/landing/legal', async (_req, res) => {
    res.json({ docs: [...LEGAL_DOC_IDS] });
  });

  router.get('/landing/legal/:doc', async (req, res, next) => {
    try {
      const docId = String(req.params.doc || '').trim();
      if (!isLegalDocId(docId)) {
        return res.status(404).json({ message: 'Not found', code: 'UNKNOWN_LEGAL_DOC' });
      }
      const snap = await db.collection('site_content').doc(`legal_${docId}`).get();
      const fallback = defaultLegalDoc(docId);
      if (!snap.exists) {
        return res.json({
          id: docId,
          title: fallback.title,
          body: fallback.body,
          updatedAt: null,
          source: 'default',
        });
      }
      const data = snap.data() || {};
      return res.json({
        id: docId,
        title: String(data.title || fallback.title),
        body: String(data.body || fallback.body),
        updatedAt: data.updatedAt ?? null,
        source: 'firestore',
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/landing/legal/:doc', async (req, res, next) => {
    try {
      const docId = String(req.params.doc || '').trim();
      if (!isLegalDocId(docId)) {
        return res.status(404).json({ message: 'Not found', code: 'UNKNOWN_LEGAL_DOC' });
      }

      const title = sanitizeLegalTitle(req.body?.title);
      const body = sanitizeLegalMarkdown(req.body?.body);
      if (!title || !body) {
        return res.status(400).json({
          message: 'title and body are required',
          code: 'INVALID_LEGAL_PAYLOAD',
        });
      }

      // Reject leftover HTML attempts
      if (/<|>/.test(title) || /<|>/.test(body)) {
        return res.status(400).json({
          message: 'HTML is not allowed; use markdown only',
          code: 'HTML_NOT_ALLOWED',
        });
      }

      const ref = db.collection('site_content').doc(`legal_${docId}`);
      const payload = {
        title,
        body,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: req.user.id,
      };
      await ref.set(payload, { merge: true });
      const snap = await ref.get();
      const data = snap.data() || {};
      res.json({
        ok: true,
        id: docId,
        title: data.title,
        body: data.body,
        updatedAt: data.updatedAt ?? null,
        source: 'firestore',
      });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerLandingAdminRoutes };
