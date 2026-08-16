/**
 * Brand domain (@simple4u.at): registration blocked except explicit whitelist.
 * Default whitelist: admin@simple4u.at (override via BRAND_EMAIL_WHITELIST / ADMIN_EMAILS).
 */

const DEFAULT_PROTECTED_DOMAINS = ['simple4u.at'];
const DEFAULT_WHITELIST = ['admin@simple4u.at'];

function normalizeEmail(email) {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

function emailDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) {
    return '';
  }
  return normalized.slice(at + 1);
}

function parseCsvList(raw, fallback) {
  const fromEnv = String(raw || '')
    .split(',')
    .map((item) => normalizeEmail(item))
    .filter(Boolean);
  return fromEnv.length ? fromEnv : fallback;
}

function protectedDomains() {
  return parseCsvList(process.env.BRAND_EMAIL_PROTECTED_DOMAINS, DEFAULT_PROTECTED_DOMAINS);
}

function brandEmailWhitelist() {
  const raw =
    process.env.BRAND_EMAIL_WHITELIST ||
    process.env.ADMIN_EMAILS ||
    process.env.ADMIN_ALLOWLIST_EMAILS ||
    '';
  return new Set(parseCsvList(raw, DEFAULT_WHITELIST));
}

function isProtectedBrandDomain(email) {
  const domain = emailDomain(email);
  return domain ? protectedDomains().includes(domain) : false;
}

function isBrandEmailWhitelisted(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && brandEmailWhitelist().has(normalized);
}

/** True when address is on a protected domain and not whitelisted (treat as "already taken"). */
function isBlockedBrandEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !isProtectedBrandDomain(normalized)) {
    return false;
  }
  return !isBrandEmailWhitelisted(normalized);
}

function adminEmailAllowlist() {
  const raw =
    process.env.ADMIN_EMAILS ||
    process.env.ADMIN_ALLOWLIST_EMAILS ||
    process.env.BRAND_EMAIL_WHITELIST ||
    '';
  return new Set(parseCsvList(raw, DEFAULT_WHITELIST));
}

function isAdminAllowlistedEmail(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && adminEmailAllowlist().has(normalized);
}

module.exports = {
  DEFAULT_PROTECTED_DOMAINS,
  DEFAULT_WHITELIST,
  normalizeEmail,
  emailDomain,
  isProtectedBrandDomain,
  isBrandEmailWhitelisted,
  isBlockedBrandEmail,
  isAdminAllowlistedEmail,
  adminEmailAllowlist,
  brandEmailWhitelist,
};
