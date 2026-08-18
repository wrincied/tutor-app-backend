/**
 * In-memory per process. Fine with minInstances: 1 (one warm API).
 * Counters split if App Hosting scales out; webhooks are skipped.
 */
function clientIp(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .trim();
  return ip || 'unknown';
}

function createRateLimiter({ windowMs, max, keyFn, skip }) {
  const hits = new Map();
  const limiter = function rateLimit(req, res, next) {
    if (typeof skip === 'function' && skip(req)) {
      return next();
    }
    const key = String(keyFn(req) || 'unknown');
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now };
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) {
      const retrySec = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retrySec));
      return res.status(429).json({ message: 'Too many requests', code: 'RATE_LIMITED' });
    }
    return next();
  };
  limiter.reset = () => hits.clear();
  limiter._hits = hits;
  return limiter;
}

function skipWebhooks(req) {
  const path = String(req.originalUrl || req.url || '');
  return (
    path.startsWith('/api/billing/webhook') ||
    path.startsWith('/api/billing/tribute-webhook') ||
    path.startsWith('/api/bot')
  );
}

function globalApiLimiter() {
  return createRateLimiter({
    windowMs: 60 * 1000,
    max: 180,
    keyFn: clientIp,
    skip: skipWebhooks,
  });
}

function passwordResetLimiter() {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 8,
    keyFn: clientIp,
  });
}

function verificationMailLimiter() {
  return createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 5,
    keyFn: (req) => req.user?.id || clientIp(req),
  });
}

function contactLimiter() {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyFn: clientIp,
  });
}

function checkoutLimiter() {
  return createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 12,
    keyFn: (req) => req.user?.id || clientIp(req),
  });
}

function healthLimiter() {
  return createRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    keyFn: clientIp,
  });
}

module.exports = {
  clientIp,
  createRateLimiter,
  skipWebhooks,
  globalApiLimiter,
  passwordResetLimiter,
  verificationMailLimiter,
  contactLimiter,
  checkoutLimiter,
  healthLimiter,
};
