const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function normalizeReferralCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

function randomReferralCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function referralCodeFromRequest(req) {
  const header = req?.headers?.['x-referral-code'];
  return normalizeReferralCode(
    req?.body?.referralCode || req?.body?.ref || req?.query?.ref || req?.query?.referralCode || header,
  );
}

async function allocateReferralCode(db, FieldValue, userRef, existingCode) {
  const current = normalizeReferralCode(existingCode);
  if (current) {
    return current;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomReferralCode();
    const clash = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if (!clash.empty) {
      continue;
    }
    await userRef.set(
      { referralCode: code, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return code;
  }
  throw new Error('Could not allocate referralCode');
}

/**
 * Bind referee → referrer once. Existing referredBy is never overwritten.
 */
async function attachReferral({ db, FieldValue, refereeUid, code }) {
  const normalized = normalizeReferralCode(code);
  if (!normalized || !refereeUid) {
    return { attached: false, reason: 'empty' };
  }

  const refereeRef = db.collection('users').doc(refereeUid);
  const refereeSnap = await refereeRef.get();
  if (!refereeSnap.exists) {
    return { attached: false, reason: 'missing_user' };
  }
  if (String(refereeSnap.data()?.referredBy || '').trim()) {
    return { attached: false, reason: 'already_set' };
  }

  const owners = await db.collection('users').where('referralCode', '==', normalized).limit(1).get();
  if (owners.empty) {
    return { attached: false, reason: 'unknown_code' };
  }
  const referrerUid = owners.docs[0].id;
  if (referrerUid === refereeUid) {
    return { attached: false, reason: 'self' };
  }

  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(refereeRef);
    if (String(fresh.data()?.referredBy || '').trim()) {
      return;
    }
    tx.update(refereeRef, {
      referredBy: referrerUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('referrals').doc(refereeUid), {
      referrerUid,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      rewardedAt: null,
    });
  });

  return { attached: true, referrerUid };
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  normalizeReferralCode,
  randomReferralCode,
  referralCodeFromRequest,
  allocateReferralCode,
  attachReferral,
};
