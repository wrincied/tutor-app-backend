const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { db } = require('./src/firebase');
const { createCorsOptions, parseCorsOrigins } = require('./src/utils/corsOrigins');

const app = express();

app.use(cors(createCorsOptions()));
const billingWebhookRoutes = require('./src/routes/billingWebhook');
const tributeWebhookRoutes = require('./src/routes/tributeWebhook');
app.use('/api/billing/webhook', billingWebhookRoutes);
app.use('/api/billing/tribute-webhook', tributeWebhookRoutes);

app.use(express.json());

// 4. ОСТАЛЬНЫЕ РОУТЫ
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

/**
 * Aggregated public health for status page.
 * Checks process (always ok if responding), Firestore reachability, Stripe API.
 */
app.get('/api/health', async (req, res) => {
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
    services.database = {
      status: 'error',
      provider: 'firestore',
      detail: err.message,
    };
  }

  const stripeKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey || stripeKey === 'your_stripe_secret_key' || !stripeKey.startsWith('sk_')) {
    services.stripe = { status: 'unconfigured' };
  } else {
    try {
      // eslint-disable-next-line global-require
      const stripe = require('stripe')(stripeKey);
      await Promise.race([
        stripe.balance.retrieve(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Stripe health timeout')), 5000);
        }),
      ]);
      services.stripe = {
        status: 'ok',
        mode: stripeKey.startsWith('sk_test_') ? 'test' : 'live',
      };
    } catch (err) {
      console.error('Health stripe:', err.message);
      services.stripe = { status: 'error', detail: err.message };
    }
  }

  const tributeKey = String(process.env.TRIBUTE_API_KEY || '').trim();
  services.tribute = tributeKey
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

  const httpStatus = status === 'error' ? 503 : 200;
  res.status(httpStatus).json({ status, checkedAt, services });
});

app.get('/api/health/firestore', async (req, res) => {
  try {
    await db.collection('lessons').limit(1).get();
    res.json({ status: 'ok', firestore: 'reachable' });
  } catch (err) {
    console.error('Firestore health:', err.message);
    res.status(503).json({ status: 'error', firestore: err.message });
  }
});
const auth = require('./src/middleware/auth');
app.delete('/api/lessons-debug/:id', auth, async (req, res, next) => {
  try {
    const lessonRef = db.collection('lessons').doc(req.params.id);
    const snap = await lessonRef.get();
    if (!snap.exists || snap.data().tutor !== req.user.id) {
      return res.status(404).json({ message: 'Lesson not found' });
    }
    await lessonRef.delete();
    res.json({ message: 'Deleted' });
  } catch (error) {
    next(error);
  }
});

app.use(errorHandler);

const { startLessonBotNotifyWorker } = require('./src/workers/lessonBotNotify');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (Firestore)`);
  console.log(`CORS origins: ${parseCorsOrigins().join(', ')}`);
  startLessonBotNotifyWorker();
});
