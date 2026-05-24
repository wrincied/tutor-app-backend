const crypto = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const ACCOUNT_PURGE_MS = 3 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

function hashVerificationToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createVerificationToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function isEmailVerified(userData) {
  if (!userData) {
    return false;
  }
  if (userData.email_verified === true) {
    return true;
  }
  if (userData.email_verified === false) {
    return false;
  }
  return true;
}

function verificationExpiresAt() {
  return new Date(Date.now() + TOKEN_TTL_MS);
}

function accountPurgeAt() {
  return new Date(Date.now() + ACCOUNT_PURGE_MS);
}

function canResendVerification(userData) {
  const sentAt = userData?.email_verification_sent_at;
  if (!sentAt) {
    return true;
  }
  const ms =
    typeof sentAt.toDate === 'function'
      ? sentAt.toDate().getTime()
      : Date.parse(sentAt);
  if (Number.isNaN(ms)) {
    return true;
  }
  return Date.now() - ms >= RESEND_COOLDOWN_MS;
}

module.exports = {
  TOKEN_TTL_MS,
  ACCOUNT_PURGE_MS,
  ACCOUNT_PURGE_DAYS: 3,
  RESEND_COOLDOWN_MS,
  hashVerificationToken,
  createVerificationToken,
  isEmailVerified,
  verificationExpiresAt,
  accountPurgeAt,
  canResendVerification,
};
