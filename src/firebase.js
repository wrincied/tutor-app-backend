const path = require('path');
const admin = require('firebase-admin');

// Явный путь к backend/.env — не зависит от process.cwd (IDE, npm из корня и т.д.).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function init() {
  if (admin.apps.length) {
    return;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (!projectId) {
    console.error(
      'Firebase Admin: задайте FIREBASE_PROJECT_ID в .env. Учётные данные — Application Default Credentials (gcloud auth application-default login или среда GCP).',
    );
    process.exit(1);
  }

  admin.initializeApp({ projectId });
}

init();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

module.exports = { admin, db, FieldValue };
