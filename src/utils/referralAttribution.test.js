const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReferralCode, attachReferral } = require('./referralAttribution');

function memoryDb(seedUsers = {}) {
  const users = new Map(Object.entries(seedUsers).map(([id, data]) => [id, { ...data }]));
  const referrals = new Map();
  return {
    users,
    referrals,
    collection(name) {
      const store = name === 'referrals' ? referrals : users;
      return {
        doc(id) {
          return {
            id,
            async get() {
              const data = store.get(id);
              return { id, exists: data != null, data: () => data };
            },
            async update(patch) {
              store.set(id, { ...(store.get(id) || {}), ...patch });
            },
            async set(patch) {
              store.set(id, { ...(store.get(id) || {}), ...patch });
            },
          };
        },
        where(field, _op, value) {
          return {
            limit() {
              return {
                async get() {
                  const docs = [...store.entries()]
                    .filter(([, data]) => data?.[field] === value)
                    .map(([id, data]) => ({
                      id,
                      exists: true,
                      data: () => data,
                    }));
                  return { empty: docs.length === 0, docs };
                },
              };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          return ref.get();
        },
        update(ref, patch) {
          return ref.update(patch);
        },
        set(ref, patch) {
          return ref.set(patch);
        },
      };
      return fn(tx);
    },
  };
}

const FieldValue = { serverTimestamp: () => 'ts' };

describe('referralAttribution', () => {
  it('normalizes codes', () => {
    assert.equal(normalizeReferralCode(' ab-12 '), 'AB12');
    assert.equal(normalizeReferralCode(''), '');
  });

  it('ignores self, missing, and already set', async () => {
    const db = memoryDb({
      a: { referralCode: 'AAAA1111' },
      b: { referredBy: 'a' },
    });
    assert.equal((await attachReferral({ db, FieldValue, refereeUid: 'a', code: 'AAAA1111' })).reason, 'self');
    assert.equal((await attachReferral({ db, FieldValue, refereeUid: 'b', code: 'AAAA1111' })).reason, 'already_set');
    assert.equal((await attachReferral({ db, FieldValue, refereeUid: 'a', code: 'NOPE' })).reason, 'unknown_code');
  });

  it('binds pending referral once', async () => {
    const db = memoryDb({
      host: { referralCode: 'HOST2222' },
      guest: { email: 'g@x.at' },
    });
    const result = await attachReferral({ db, FieldValue, refereeUid: 'guest', code: 'host2222' });
    assert.equal(result.attached, true);
    assert.equal(result.referrerUid, 'host');
    assert.equal(db.users.get('guest').referredBy, 'host');
    assert.equal(db.referrals.get('guest').status, 'pending');
  });
});
