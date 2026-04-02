/**
 * Обновляет password_hash в Firestore (bcrypt, 10 раундов — как в authController).
 *
 * Запуск из папки backend:
 *   node scripts/reset-user-password.js <email> <новый_пароль>
 *
 * Или переменные окружения: RESET_USER_EMAIL, RESET_USER_PASSWORD
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, FieldValue } = require('../src/firebase');
const bcrypt = require('bcryptjs');

const email = (process.argv[2] || process.env.RESET_USER_EMAIL || '').trim();
const password = process.argv[3] || process.env.RESET_USER_PASSWORD || '';

async function main() {
  if (!process.env.FIREBASE_PROJECT_ID) {
    console.error('В .env не задан FIREBASE_PROJECT_ID. Нужны Application Default Credentials (gcloud auth application-default login).');
    process.exit(1);
  }
  if (!email || !password) {
    console.error('Укажите email и пароль:');
    console.error('  node scripts/reset-user-password.js <email> <новый_пароль>');
    console.error('или RESET_USER_EMAIL и RESET_USER_PASSWORD');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Пароль не короче 6 символов (как в API регистрации).');
    process.exit(1);
  }

  const normalized = email.toLowerCase();
  const snap = await db.collection('users').where('email', '==', normalized).limit(1).get();

  if (snap.empty) {
    console.error('Пользователь с email', normalized, 'не найден.');
    process.exit(1);
  }

  const doc = snap.docs[0];
  const password_hash = await bcrypt.hash(password, 10);
  await doc.ref.update({
    password_hash,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log('Поле password_hash обновлено для', normalized);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
