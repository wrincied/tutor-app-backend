const nodemailer = require('nodemailer');
const {
  createVerificationToken,
  hashVerificationToken,
  verificationExpiresAt,
  accountPurgeAt,
} = require('../utils/emailVerification');

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}

function createTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || '',
    },
  });
}

function verificationLink(token) {
  const frontend = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
  return `${frontend}/verify-email?token=${encodeURIComponent(token)}`;
}

function buildVerificationEmail({ email, link, purgeDays }) {
  const appName = process.env.APP_NAME || 'Simple4U';
  const subject = `${appName}: подтвердите email`;
  const text = [
    `Здравствуйте!`,
    ``,
    `Подтвердите адрес ${email}, чтобы войти в ${appName}:`,
    link,
    ``,
    `Ссылка действует 48 часов.`,
    `Если вы не регистрировались, просто проигнорируйте письмо.`,
    `Неподтверждённый аккаунт будет удалён через ${purgeDays} дней.`,
  ].join('\n');
  const html = `
    <p>Здравствуйте!</p>
    <p>Подтвердите адрес <strong>${email}</strong>, чтобы войти в ${appName}:</p>
    <p><a href="${link}">Подтвердить email</a></p>
    <p>Ссылка действует 48 часов.</p>
    <p>Неподтверждённый аккаунт будет удалён через ${purgeDays} дней.</p>
  `;
  return { subject, text, html };
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@simple4u.local';

  if (!smtpConfigured()) {
    console.info('[email] SMTP not configured — verification link (dev):');
    console.info(text);
    return { sent: false, devMode: true };
  }

  const transport = createTransport();
  await transport.sendMail({ from, to, subject, text, html });
  return { sent: true, devMode: false };
}

/**
 * Генерирует токен и поля для записи в Firestore (без отправки).
 */
function buildVerificationFields() {
  const token = createVerificationToken();
  return {
    token,
    patch: {
      email_verification_token_hash: hashVerificationToken(token),
      email_verification_expires_at: verificationExpiresAt(),
      account_purge_at: accountPurgeAt(),
    },
  };
}

async function sendVerificationEmail(email) {
  const { token, patch } = buildVerificationFields();
  const link = verificationLink(token);
  const purgeDays = 3;
  const content = buildVerificationEmail({ email, link, purgeDays });
  await sendMail({ to: email, ...content });
  return { patch, link };
}

module.exports = {
  sendVerificationEmail,
  buildVerificationFields,
  verificationLink,
  sendMail,
};
