const DEFAULT_PROD_ORIGINS = [
  'https://simple4u.at',
  'https://www.simple4u.at',
  'https://simple4u-64822.web.app',
  'https://simple4u-64822.firebaseapp.com',
  /** GitHub Pages team preview: https://wrincied.github.io/tutor-app/dev/ */
  'https://wrincied.github.io',
];
const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:4200',
  'http://localhost:4300',
  'http://localhost:4400',
];

function defaultOrigins() {
  if (process.env.NODE_ENV === 'production') {
    return DEFAULT_PROD_ORIGINS;
  }
  return [...DEFAULT_LOCAL_ORIGINS, ...DEFAULT_PROD_ORIGINS];
}

function normalizeOrigin(value) {
  return String(value ?? '').trim().replace(/\/$/, '');
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function parseCorsOrigins() {
  const raw = process.env.FRONTEND_URL;
  const fromEnv = raw
    ? raw
        .split(',')
        .map((item) => normalizeOrigin(item))
        .filter(Boolean)
    : [];
  const merged = [...new Set([...fromEnv, ...defaultOrigins().map(normalizeOrigin)])];
  if (process.env.NODE_ENV === 'production') {
    return merged.filter((origin) => !isLocalOrigin(origin));
  }
  return merged;
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
  // Local API without FRONTEND_URL should never bounce users to prod App Hosting.
  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:4200';
  }
  return 'https://simple4u.at';
}

/**
 * Deep link into the Angular hash router.
 * Query string goes BEFORE the hash so Stripe can append session_id safely
 * and Angular still lands on the right route.
 * Example: spaDeepLink('/app/home', { billing: 'success' })
 * → http://localhost:4200/?billing=success#/app/home
 */
function spaDeepLink(pathWithQuery, query) {
  const base = primaryFrontendUrl();
  let path = String(pathWithQuery || '/');
  let inlineQuery = '';
  const qIdx = path.indexOf('?');
  if (qIdx >= 0) {
    inlineQuery = path.slice(qIdx + 1);
    path = path.slice(0, qIdx);
  }
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  const params = new URLSearchParams(inlineQuery);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') {
        continue;
      }
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}/?${qs}#${path}` : `${base}/#${path}`;
}

/**
 * Path-router URL (no hash). Used for Tribute success/fail redirects.
 * Example: spaPathLink('/payment', { billing: 'success' })
 * → https://simple4u.at/payment?billing=success
 */
function spaPathLink(pathWithQuery, query) {
  const base = primaryFrontendUrl();
  let path = String(pathWithQuery || '/');
  let inlineQuery = '';
  const qIdx = path.indexOf('?');
  if (qIdx >= 0) {
    inlineQuery = path.slice(qIdx + 1);
    path = path.slice(0, qIdx);
  }
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  const params = new URLSearchParams(inlineQuery);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') {
        continue;
      }
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };
}

module.exports = {
  parseCorsOrigins,
  primaryFrontendUrl,
  spaDeepLink,
  spaPathLink,
  createCorsOptions,
};
