const { admin } = require('../firebase');
const { primaryFrontendUrl, spaPathLink } = require('../utils/corsOrigins');
const { sendMail } = require('./emailService');

/**
 * Firebase Console blocks custom action URLs (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED).
 * We generate an oob link with Admin SDK, then rewrite the host/path to our SPA handler.
 */
function toAppActionLink(firebaseLink) {
  const parsed = new URL(String(firebaseLink || ''));
  const base = primaryFrontendUrl().replace(/\/$/, '');
  return `${base}/auth/action?${parsed.searchParams.toString()}`;
}

function buildPasswordResetEmail({ email, link }) {
  const appName = process.env.APP_NAME || 'Simple4U';
  const subject = `${appName}: reset your password`;
  const text = [
    `Hello,`,
    ``,
    `Reset the password for ${email} on ${appName}:`,
    link,
    ``,
    `If you did not request this, you can ignore this email.`,
  ].join('\n');
  const html = `
    <p>Hello,</p>
    <p>Reset the password for <strong>${email}</strong> on ${appName}:</p>
    <p><a href="${link}">Set a new password</a></p>
    <p>If you did not request this, you can ignore this email.</p>
  `;
  return { subject, text, html };
}

/**
 * Always resolves with { ok: true } for unknown emails (no account enumeration).
 */
async function sendPasswordResetForEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { ok: false, reason: 'invalid_email' };
  }

  const { isBlockedBrandEmail } = require('../utils/brandEmail');
  if (isBlockedBrandEmail(email)) {
    return { ok: true };
  }

  try {
    try {
      await admin.auth().getUserByEmail(email);
    } catch (lookupErr) {
      const lookupCode = lookupErr?.code || lookupErr?.errorInfo?.code || '';
      if (lookupCode === 'auth/user-not-found') {
        return { ok: true };
      }
      throw lookupErr;
    }

    const continueUrl = spaPathLink('/login');
    const firebaseLink = await admin.auth().generatePasswordResetLink(email, {
      url: continueUrl,
      handleCodeInApp: false,
    });
    const link = toAppActionLink(firebaseLink);
    const content = buildPasswordResetEmail({ email, link });
    await sendMail({ to: email, ...content });
  } catch (err) {
    const code = err?.code || err?.errorInfo?.code || '';
    if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
      return { ok: true };
    }
    console.warn('[password-reset]', code || err?.message || err);
    throw err;
  }

  return { ok: true };
}

module.exports = {
  sendPasswordResetForEmail,
  toAppActionLink,
};
