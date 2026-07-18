/** Firebase-style document ids: alphanumeric, length bounds. */
function isSafeFirestoreId(value, { min = 8, max = 128 } = {}) {
  const id = String(value ?? '');
  if (id.length < min || id.length > max) {
    return false;
  }
  // Reject path traversal / injection characters
  if (id.includes('/') || id.includes('..') || id.includes('\\')) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(id);
}

module.exports = { isSafeFirestoreId };
