function parseCsvSet(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

function parseEmailAllowlist() {
  const raw =
    process.env.ADMIN_GITHUB_EMAILS ||
    process.env.ADMIN_ALLOWLIST_EMAILS ||
    process.env.ADMIN_GOOGLE_EMAILS ||
    '';
  return new Set([...parseCsvSet(raw)].map((email) => email.toLowerCase()));
}

function parseUidAllowlist() {
  return parseCsvSet(process.env.ADMIN_GITHUB_UIDS || '');
}

/** True if uid/email is in ADMIN_GITHUB_EMAILS and/or ADMIN_GITHUB_UIDS. */
function isAdminAllowlisted(uid, email) {
  const emails = parseEmailAllowlist();
  const uids = parseUidAllowlist();
  if (emails.size === 0 && uids.size === 0) {
    return false;
  }
  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();
  const emailOk = Boolean(normalizedEmail && emails.has(normalizedEmail));
  const uidOk = Boolean(uid && uids.has(String(uid)));
  return emailOk || uidOk;
}

module.exports = {
  parseEmailAllowlist,
  parseUidAllowlist,
  isAdminAllowlisted,
};
