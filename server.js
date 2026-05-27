const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { db } = require('./src/firebase');
const { createCorsOptions, parseCorsOrigins } = require('./src/utils/corsOrigins');

const app = express();

app.use(cors(createCorsOptions()));
const billingWebhookRoutes = require('./src/routes/billingWebhook');
app.use('/api/billing/webhook', billingWebhookRoutes);

app.use(express.json());

// 4. ОСТАЛЬНЫЕ РОУТЫ
const authRoutes = require('./src/routes/auth');
const studentRoutes = require('./src/routes/students');
const lessonRoutes = require('./src/routes/lessons');
const financeRoutes = require('./src/routes/finance');
const billingRoutes = require('./src/routes/billing');
const adminRoutes = require('./src/routes/admin');
const errorHandler = require('./src/middleware/error');

app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/lessons', lessonRoutes);
app.use('/api/finance', financeRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'tutor-backend' });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', db: 'firestore' }));

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (Firestore)`);
  console.log(`CORS origins: ${parseCorsOrigins().join(', ')}`);
});
