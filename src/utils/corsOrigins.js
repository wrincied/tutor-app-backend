const DEFAULT_ORIGINS = [
  'http://localhost:4200',
  'https://tutor-app--tutorassis.europe-west4.hosted.app',
  'https://tutorassis.web.app',
  'https://tutorassis.firebaseapp.com',
];

function parseCorsOrigins() {
  const raw = process.env.FRONTEND_URL;
  const fromEnv = raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  return [...new Set([...fromEnv, ...DEFAULT_ORIGINS])];
}

function createCorsOptions() {
  const allowed = parseCorsOrigins();
  return {
    origin(origin, callback) {
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}

module.exports = {
  parseCorsOrigins,
  createCorsOptions,
};
