const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { db } = require('./src/firebase');

// 1. СНАЧАЛА СОЗДАЕМ APP
const app = express();

// 2. НАСТРАИВАЕМ МИДЛВАРЫ
app.use(
  cors({
    origin: '*', // Разрешаем всем (для локалки ок)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Явно разрешаем DELETE
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

// 4. ОСТАЛЬНЫЕ РОУТЫ
const authRoutes = require('./src/routes/auth');
const studentRoutes = require('./src/routes/students');
const lessonRoutes = require('./src/routes/lessons');
const financeRoutes = require('./src/routes/finance');
const errorHandler = require('./src/middleware/error');

app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/lessons', lessonRoutes);
app.use('/api/finance', financeRoutes);

// Health check и остальное...
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
app.delete('/api/lessons-debug/:id', (req, res) => {
  console.log('!!! DEBUG DELETE HIT !!! ID:', req.params.id);
  res.status(200).json({ message: 'Debug route works!' });
});
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (Firestore)`);
});
