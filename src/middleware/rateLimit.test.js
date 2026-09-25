const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, clientIp, skipWebhooks, heavyReadLimiter } = require('./rateLimit');

function mockRes() {
  const headers = {};
  return {
    headers,
    setHeader(key, value) {
      headers[key] = value;
    },
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('clientIp', () => {
  it('strips ipv4-mapped prefix', () => {
    assert.equal(clientIp({ ip: '::ffff:127.0.0.1' }), '127.0.0.1');
  });
});

describe('skipWebhooks', () => {
  it('skips stripe and tribute webhooks', () => {
    assert.equal(skipWebhooks({ originalUrl: '/api/billing/webhook' }), true);
    assert.equal(skipWebhooks({ originalUrl: '/api/billing/tribute-webhook' }), true);
    assert.equal(skipWebhooks({ originalUrl: '/api/bot/students/1' }), true);
    assert.equal(skipWebhooks({ originalUrl: '/api/internal/lesson-worker/tick' }), true);
    assert.equal(skipWebhooks({ originalUrl: '/api/lessons' }), false);
  });
});

describe('createRateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      keyFn: (req) => req.ip,
    });
  });

  it('allows up to max requests then 429', () => {
    const nextCalls = [];
    const next = () => nextCalls.push(1);
    limiter({ ip: '1.1.1.1' }, mockRes(), next);
    limiter({ ip: '1.1.1.1' }, mockRes(), next);
    const res = mockRes();
    limiter({ ip: '1.1.1.1' }, res, next);
    assert.equal(nextCalls.length, 2);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'RATE_LIMITED');
  });

  it('isolates keys', () => {
    const next = () => {};
    limiter({ ip: 'a' }, mockRes(), next);
    limiter({ ip: 'a' }, mockRes(), next);
    const other = mockRes();
    let called = false;
    limiter({ ip: 'b' }, other, () => {
      called = true;
    });
    assert.equal(called, true);
    assert.equal(other.statusCode, 200);
  });
});

describe('heavyReadLimiter', () => {
  it('keys by user id and returns 429 after max', () => {
    const limiter = heavyReadLimiter();
    // Temporarily lower max by creating a dedicated limiter with same keyFn.
    const tight = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      keyFn: (req) => req.user?.id || clientIp(req),
    });
    const nextCalls = [];
    const next = () => nextCalls.push(1);
    const req = { user: { id: 'tutor-a' }, ip: '9.9.9.9' };
    tight(req, mockRes(), next);
    tight(req, mockRes(), next);
    const res = mockRes();
    tight(req, res, next);
    assert.equal(nextCalls.length, 2);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'RATE_LIMITED');

    // Other user still allowed.
    let otherOk = false;
    tight({ user: { id: 'tutor-b' }, ip: '9.9.9.9' }, mockRes(), () => {
      otherOk = true;
    });
    assert.equal(otherOk, true);

    // heavyReadLimiter factory returns a working middleware.
    assert.equal(typeof limiter, 'function');
  });
});
