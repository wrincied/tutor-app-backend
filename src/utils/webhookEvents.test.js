const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { eventDocId } = require('./webhookEvents');

describe('eventDocId', () => {
  it('prefixes source and keeps stripe-like ids', () => {
    assert.equal(eventDocId('stripe', 'evt_123'), 'stripe_evt_123');
  });

  it('caps length for Firestore document ids', () => {
    const id = eventDocId('tribute', 'x'.repeat(800));
    assert.ok(id.length <= 700);
  });
});
