const express = require('express');
const { db, FieldValue } = require('../firebase');
const {
  LEGAL_DOC_IDS,
  isLegalDocId,
  defaultLegalDoc,
} = require('../utils/legalContent');
const { sendMail } = require('../services/emailService');
const { contactLimiter, clientIp } = require('../middleware/rateLimit');

const router = express.Router();
const limitContact = contactLimiter();

function contactEmail() {
  const fromEnv = String(process.env.CONTACT_EMAIL || '').trim();
  return fromEnv || 'support@simple4u.at';
}

async function verifyRecaptcha(token, ip) {
  const secret = String(process.env.RECAPTCHA_SECRET_KEY || '').trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, skipped: false };
    }
    return { ok: true, skipped: true };
  }
  if (!token) {
    return { ok: false, skipped: false };
  }
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', String(token));
  if (ip) body.set('remoteip', String(ip));
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  const score = typeof data.score === 'number' ? data.score : null;
  // v3 returns score; v2 checkbox has no score. Accept either success.
  const scoreOk = score === null || score >= 0.4;
  return { ok: Boolean(data.success) && scoreOk, skipped: false, score };
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

/** POST /api/public/contact — help center form */
router.post('/contact', limitContact, async (req, res, next) => {
  try {
    const ip = clientIp(req);

    const name = String(req.body?.name || '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().slice(0, 200);
    const subject = String(req.body?.subject || '').trim().slice(0, 160);
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    const recaptchaToken =
      req.body?.recaptchaToken ||
      req.body?.gRecaptchaResponse ||
      req.body?.turnstileToken ||
      req.body?.cfTurnstileResponse ||
      '';

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ message: 'Invalid payload', code: 'INVALID_CONTACT' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email', code: 'INVALID_EMAIL' });
    }

    const captcha = await verifyRecaptcha(recaptchaToken, ip);
    if (!captcha.ok) {
      return res.status(400).json({ message: 'Captcha failed', code: 'CAPTCHA_FAILED' });
    }

    const to = contactEmail();
    const text = [
      `New support message from Simple4U Help Center`,
      ``,
      `Name: ${name}`,
      `Email: ${email}`,
      `Subject: ${subject}`,
      ``,
      message,
    ].join('\n');
    const html = `
      <p><strong>New support message</strong></p>
      <p>Name: ${escapeHtml(name)}<br/>Email: ${escapeHtml(email)}<br/>Subject: ${escapeHtml(subject)}</p>
      <pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(message)}</pre>
    `;

    let mailResult = { sent: false, devMode: true };
    try {
      mailResult = await sendMail({
        to,
        subject: `[Simple4U] ${subject}`,
        text,
        html,
        replyTo: email,
      });
    } catch (mailErr) {
      console.error('[contact] sendMail failed', mailErr?.message || mailErr);
      mailResult = { sent: false, devMode: false, error: true };
    }

    // Always persist — works even when SMTP is not configured.
    try {
      await db.collection('contact_messages').add({
        name,
        email,
        subject,
        message,
        to,
        ip: ip || null,
        emailSent: Boolean(mailResult?.sent),
        emailDevMode: Boolean(mailResult?.devMode),
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (storeErr) {
      console.error('[contact] firestore persist failed', storeErr?.message || storeErr);
      if (!mailResult?.sent) {
        return res.status(503).json({
          message: 'Could not store or send message',
          code: 'CONTACT_UNAVAILABLE',
        });
      }
    }

    return res.json({
      ok: true,
      emailed: Boolean(mailResult?.sent),
    });
  } catch (error) {
    next(error);
  }
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** GET /api/public/legal — list ids */
router.get('/legal', (_req, res) => {
  res.json({ docs: [...LEGAL_DOC_IDS] });
});

module.exports = router;
