const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyTributeSignature } = require('./tribute');

describe('tribute signature', () => {
  it('accepts HMAC-SHA256 hex of the raw body', () => {
    const prev = process.env.TRIBUTE_API_KEY;
    process.env.TRIBUTE_API_KEY = 'test-tribute-key';
    try {
      const body = '{"name":"shop_order_payment_received"}';
      const sig = crypto.createHmac('sha256', 'test-tribute-key').update(body).digest('hex');
      assert.equal(verifyTributeSignature(body, sig), true);
      assert.equal(verifyTributeSignature(body, `sha256=${sig}`), true);
      assert.equal(verifyTributeSignature(body, 'deadbeef'), false);
    } finally {
      if (prev === undefined) {
        delete process.env.TRIBUTE_API_KEY;
      } else {
        process.env.TRIBUTE_API_KEY = prev;
      }
    }
  });
});
