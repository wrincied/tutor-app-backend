const DEFAULT_ORIGINS = [
  'http://localhost:4200',
  'https://tutor-app--tutorassis.europe-west4.hosted.app',
  'https://tutorassis.web.app',
  'https://tutorassis.firebaseapp.com',
  'https://simple4u-64822.web.app',
  'https://simple4u-64822.firebaseapp.com',
];

function normalizeOrigin(value) {
  return String(value ?? '').trim().replace(/\/$/, '');
}

function parseCorsOrigins() {
  const raw = process.env.FRONTEND_URL;
  const fromEnv = raw
    ? raw
        .split(',')
        .map((item) => normalizeOrigin(item))
        .filter(Boolean)
    : [];
  return [...new Set([...fromEnv, ...DEFAULT_ORIGINS.map(normalizeOrigin)])];
}

/** Primary SPA URL for redirects (Stripe, email links). */
function primaryFrontendUrl() {
  const fromEnv = process.env.FRONTEND_URL;
  if (fromEnv) {
    const first = fromEnv
      .split(',')
      .map((item) => normalizeOrigin(item))
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  return 'https://tutor-app--tutorassis.europe-west4.hosted.app';
}

function createCorsOptions() {
  const allowed = new Set(parseCorsOrigins());
  return {
    origin(origin, callback) {
      const normalized = normalizeOrigin(origin);
      if (!normalized || allowed.has(normalized)) {
        callback(null, normalized || true);
        return;
      }
      console.warn(`CORS blocked origin: ${origin}`);
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };
}

module.exports = {
  parseCorsOrigins,
  primaryFrontendUrl,
  createCorsOptions,
};
