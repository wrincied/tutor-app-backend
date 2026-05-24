const { db, FieldValue } = require('../firebase');
const {
  hashVerificationToken,
  isEmailVerified,
  canResendVerification,
  ACCOUNT_PURGE_DAYS,
} = require('../utils/emailVerification');
const { sendVerificationEmail } = require('./emailService');

async function assignAndSendVerification(userRef, email) {
  const { patch } = await sendVerificationEmail(email);
  await userRef.update({
    ...patch,
    email_verification_sent_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function verifyEmailByToken(token) {
  const normalized = String(token || '').trim();
  if (!normalized) {
    return { ok: false, reason: 'missing_token' };
  }

  const hash = hashVerificationToken(normalized);
  const snap = await db
    .collection('users')
    .where('email_verification_token_hash', '==', hash)
    .limit(1)
    .get();

  if (snap.empty) {
    return { ok: false, reason: 'invalid_token' };
  }

  const doc = snap.docs[0];
  const data = doc.data();

  if (isEmailVerified(data)) {
    return { ok: true, already: true, email: data.email };
  }

  const expRaw = data.email_verification_expires_at;
  const expMs =
    expRaw && typeof expRaw.toDate === 'function'
      ? expRaw.toDate().getTime()
      : Date.parse(expRaw);
  if (!expMs || Number.isNaN(expMs) || Date.now() > expMs) {
    return { ok: false, reason: 'expired_token' };
  }

  await doc.ref.update({
    email_verified: true,
    email_verification_token_hash: FieldValue.delete(),
    email_verification_expires_at: FieldValue.delete(),
    account_purge_at: FieldValue.delete(),
    email_verified_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, email: data.email };
}

async function resendVerificationForEmail(normalizedEmail) {
  const snap = await db.collection('users').where('email', '==', normalizedEmail).limit(1).get();
  if (snap.empty) {
    return { ok: true, silent: true };
  }

  const doc = snap.docs[0];
  const data = doc.data();

  if (isEmailVerified(data)) {
    return { ok: false, reason: 'already_verified' };
  }

  if (!canResendVerification(data)) {
    return { ok: false, reason: 'cooldown' };
  }

  await assignAndSendVerification(doc.ref, data.email);
  return { ok: true, purgeDays: ACCOUNT_PURGE_DAYS };
}

module.exports = {
  assignAndSendVerification,
  verifyEmailByToken,
  resendVerificationForEmail,
};
