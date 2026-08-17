const { admin } = require('../firebase');
const { primaryFrontendUrl, spaPathLink } = require('../utils/corsOrigins');
const { toAppActionLink } = require('../utils/authActionLink');
const { sendMail } = require('./emailService');

function buildVerificationEmail({ email, link }) {
  const appName = process.env.APP_NAME || 'Simple4U';
  const subject = `${appName}: confirm your email`;
  const text = [
    `Hello,`,
    ``,
    `Confirm ${email} to finish signing up for ${appName}:`,
    link,
    ``,
    `If you did not create an account, you can ignore this email.`,
  ].join('\n');
  const html = `
    <p>Hello,</p>
    <p>Confirm <strong>${email}</strong> to finish signing up for ${appName}:</p>
    <p><a href="${link}">Confirm email</a></p>
    <p>If you did not create an account, you can ignore this email.</p>
  `;
  return { subject, text, html };
}

/**
 * Send Firebase email-verification oob link via Resend/SMTP, pointing at /auth/action.
 */
async function sendVerificationEmailForAddress(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { ok: false, reason: 'invalid_email' };
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (err) {
    const code = err?.code || err?.errorInfo?.code || '';
    if (code === 'auth/user-not-found') {
      return { ok: false, reason: 'user_not_found' };
    }
    throw err;
  }

  if (user.emailVerified) {
    return { ok: true, alreadyVerified: true };
  }

  const continueUrl = spaPathLink('/login', { verify: 'success' });
  const firebaseLink = await admin.auth().generateEmailVerificationLink(email, {
    url: continueUrl,
    handleCodeInApp: false,
  });
  const link = toAppActionLink(firebaseLink, primaryFrontendUrl());
  const content = buildVerificationEmail({ email, link });
  await sendMail({ to: email, ...content });
  return { ok: true };
}

module.exports = {
  sendVerificationEmailForAddress,
  buildVerificationEmail,
};
