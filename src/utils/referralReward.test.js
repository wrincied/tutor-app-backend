const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyReferralOnFirstPaid, proExpiresPatch, addDays } = require('./referralReward');

function memoryDb(seed) {
  const users = new Map(Object.entries(seed.users || {}));
  const referrals = new Map(Object.entries(seed.referrals || {}));
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
              return { exists: data != null, data: () => data, id };
            },
            async update(patch) {
              const prev = store.get(id) || {};
              const next = { ...prev };
              for (const [key, value] of Object.entries(patch)) {
                if (value && value.__delete) {
                  delete next[key];
                } else {
                  next[key] = value;
                }
              }
              store.set(id, next);
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
      };
      return fn(tx);
    },
  };
}

const FieldValue = {
  serverTimestamp: () => 'ts',
  delete: () => ({ __delete: true }),
};

describe('referralReward', () => {
  it('skips zero trial invoices and already rewarded', async () => {
    const db = memoryDb({
      referrals: { p: { referrerUid: 'r', status: 'pending' } },
    });
    assert.equal((await applyReferralOnFirstPaid({ db, FieldValue, payerUid: 'p', amountPaid: 0 })).reason, 'not_paid');
    db.referrals.set('p', { referrerUid: 'r', status: 'rewarded' });
    assert.equal(
      (await applyReferralOnFirstPaid({ db, FieldValue, payerUid: 'p', amountPaid: 999 })).reason,
      'already_rewarded',
    );
  });

  it('credits Stripe customer when present', async () => {
    const created = [];
    const stripe = {
      customers: {
        createBalanceTransaction: async (id, body) => {
          created.push({ id, body });
        },
      },
    };
    const db = memoryDb({
      users: {
        r: {
          stripe_customer_id: 'cus_1',
          tax_mode: 'at-self-employed',
          country_settings: 'AT',
        },
      },
      referrals: { p: { referrerUid: 'r', status: 'pending' } },
    });
    const result = await applyReferralOnFirstPaid({
      db,
      FieldValue,
      stripe,
      payerUid: 'p',
      amountPaid: 7999,
    });
    assert.equal(result.kind, 'stripe_credit');
    assert.equal(created[0].id, 'cus_1');
    assert.equal(created[0].body.amount, -999);
    assert.equal(created[0].body.currency, 'eur');
    assert.equal(db.referrals.get('p').status, 'rewarded');
    assert.equal(db.users.get('r').stripe_credit_notice.amount, 9.99);
  });

  it('extends proExpiresAt by 30 days without Stripe', async () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    const db = memoryDb({
      users: {
        r: { subscription_status: 'pro', proExpiresAt: '2026-11-18T00:00:00.000Z' },
      },
      referrals: { p: { referrerUid: 'r', status: 'pending' } },
    });
    const result = await applyReferralOnFirstPaid({
      db,
      FieldValue,
      stripe: null,
      payerUid: 'p',
      amountPaid: 100,
      now,
    });
    assert.equal(result.kind, 'pro_expires');
    assert.equal(db.users.get('r').proExpiresAt, '2026-12-18T00:00:00.000Z');
  });

  it('proExpiresPatch starts from now when unlimited', () => {
    const FieldValueLocal = { serverTimestamp: () => 'ts', delete: () => ({ __delete: true }) };
    const now = new Date('2026-08-18T00:00:00.000Z');
    const patch = proExpiresPatch({}, now, FieldValueLocal);
    assert.equal(patch.subscription_status, 'pro');
    assert.equal(patch.proExpiresAt, addDays(now, 30).toISOString());
  });
});
