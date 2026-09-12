const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { db } = require('./src/firebase');
const { createCorsOptions, parseCorsOrigins } = require('./src/utils/corsOrigins');

const app = express();

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});
app.use(cors(createCorsOptions()));
const billingWebhookRoutes = require('./src/routes/billingWebhook');
const tributeWebhookRoutes = require('./src/routes/tributeWebhook');
app.use('/api/billing/webhook', billingWebhookRoutes);
app.use('/api/billing/tribute-webhook', tributeWebhookRoutes);

app.use(express.json({ limit: '200kb' }));

const { globalApiLimiter, healthLimiter } = require('./src/middleware/rateLimit');
app.use(globalApiLimiter());

const authRoutes = require('./src/routes/auth');
const studentRoutes = require('./src/routes/students');
const lessonRoutes = require('./src/routes/lessons');
const financeRoutes = require('./src/routes/finance');
const billingRoutes = require('./src/routes/billing');
const adminRoutes = require('./src/routes/admin');
const accountRoutes = require('./src/routes/account');
const publicLegalRoutes = require('./src/routes/publicLegal');
const errorHandler = require('./src/middleware/error');

app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/public', publicLegalRoutes);
app.use('/api/bot', require('./src/routes/botWebhook'));
app.use('/api/students', studentRoutes);
app.use('/api/lessons', lessonRoutes);
app.use('/api/finance', financeRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'tutor-backend' });
});

const limitHealth = healthLimiter();
let stripeHealthCache = { at: 0, status: 'unconfigured' };

async function readStripeHealth() {
  const stripeKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey || stripeKey === 'your_stripe_secret_key' || !stripeKey.startsWith('sk_')) {
    return { status: 'unconfigured' };
  }
  const now = Date.now();
  if (now - stripeHealthCache.at < 60_000 && stripeHealthCache.status !== 'unconfigured') {
    return { status: stripeHealthCache.status };
  }
  try {
    // eslint-disable-next-line global-require
    const stripe = require('stripe')(stripeKey);
    await Promise.race([
      stripe.balance.retrieve(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Stripe health timeout')), 5000);
      }),
    ]);
    stripeHealthCache = { at: now, status: 'ok' };
    return { status: 'ok' };
  } catch (err) {
    console.error('Health stripe:', err.message);
    stripeHealthCache = { at: now, status: 'error' };
    return { status: 'error' };
  }
}

app.get('/api/health', limitHealth, async (req, res) => {
  const checkedAt = new Date().toISOString();
  const services = {
    app: { status: 'ok' },
    database: { status: 'error', provider: 'firestore' },
    stripe: { status: 'unconfigured' },
    tribute: { status: 'unconfigured' },
  };

  try {
    await db.collection('lessons').limit(1).get();
    services.database = { status: 'ok', provider: 'firestore' };
  } catch (err) {
    console.error('Health database:', err.message);
    services.database = { status: 'error', provider: 'firestore' };
  }

  services.stripe = await readStripeHealth();
  services.tribute = String(process.env.TRIBUTE_API_KEY || '').trim()
    ? { status: 'ok', provider: 'tribute' }
    : { status: 'unconfigured' };

  const states = [services.app.status, services.database.status, services.stripe.status];
  let status = 'ok';
  if (states.every((s) => s === 'ok')) {
    status = 'ok';
  } else if (services.database.status === 'error' && services.stripe.status === 'error') {
    status = 'error';
  } else {
    status = 'degraded';
  }

  res.status(status === 'error' ? 503 : 200).json({ status, checkedAt, services });
});

app.get('/api/health/firestore', limitHealth, async (req, res) => {
  try {
    await db.collection('lessons').limit(1).get();
    res.json({ status: 'ok', firestore: 'reachable' });
  } catch (err) {
    console.error('Firestore health:', err.message);
    res.status(503).json({ status: 'error', firestore: 'unreachable' });
  }
});

app.use(errorHandler);

const { startLessonBotNotifyWorker } = require('./src/workers/lessonBotNotify');
const { startBillingWorker } = require('./src/utils/billingWorker');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (Firestore)`);
  console.log(`CORS origins: ${parseCorsOrigins().join(', ')}`);
  startLessonBotNotifyWorker();
  // Fallback only when LESSON_BOT_NOTIFY_DISABLED=1; otherwise cycle runs from notify tick.
  startBillingWorker();
});
