function parseCsvSet(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

function parseUidAllowlist() {
  return parseCsvSet(process.env.ADMIN_GITHUB_UIDS || '');
}

/** True if Firebase UID is in ADMIN_GITHUB_UIDS (email is ignored). */
function isAdminAllowlisted(uid) {
  const uids = parseUidAllowlist();
  if (uids.size === 0) {
    return false;
  }
  return Boolean(uid && uids.has(String(uid)));
}

module.exports = {
  parseUidAllowlist,
  isAdminAllowlisted,
};
