const nodemailer = require('nodemailer');

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

async function sendMail({ to, subject, text, html, replyTo }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@simple4u.local';

  if (!smtpConfigured()) {
    console.info('[email] SMTP not configured — message (dev):');
    console.info({ to, subject, replyTo, text });
    return { sent: false, devMode: true };
  }

  const transport = createTransport();
  await transport.sendMail({
    from,
    to,
    subject,
    text,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
  return { sent: true, devMode: false };
}

module.exports = {
  sendMail,
};
