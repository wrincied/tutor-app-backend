const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function tryParseServiceAccount(rawValue) {
  if (!rawValue) {
    return null;
  }
  try {
    return JSON.parse(rawValue);
  } catch (_error) {
    return null;
  }
}

function loadServiceAccount() {
  const directJson = tryParseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (directJson) {
    return directJson;
  }

  const base64Value = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64Value) {
    const decoded = Buffer.from(base64Value, 'base64').toString('utf8');
    const parsed = tryParseServiceAccount(decoded);
    if (parsed) {
      return parsed;
    }
  }

  const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath) {
    const fullPath = path.isAbsolute(envPath)
      ? envPath
      : path.resolve(__dirname, '..', envPath);
    if (fs.existsSync(fullPath)) {
      return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    }
  }

  const localCandidate = path.resolve(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(localCandidate)) {
    return JSON.parse(fs.readFileSync(localCandidate, 'utf8'));
  }

  return null;
}

function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  const serviceAccount = loadServiceAccount();

  const options = {};
  if (projectId) {
    options.projectId = projectId;
  }
  if (storageBucket) {
    options.storageBucket = storageBucket;
  }

  if (serviceAccount) {
    options.credential = admin.credential.cert(serviceAccount);
  } else {
    options.credential = admin.credential.applicationDefault();
  }

  return admin.initializeApp(options);
}

initFirebaseAdmin();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

module.exports = {
  admin,
  db,
  FieldValue,
  Timestamp,
};
