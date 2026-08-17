/**
 * Firebase Console blocks custom action handler URLs.
 * Admin SDK still embeds the default firebaseapp handler — rewrite to our SPA.
 */
function toAppActionLink(firebaseLink, frontendBase) {
  const parsed = new URL(String(firebaseLink || ''));
  const base = String(frontendBase || '')
    .replace(/\/$/, '');
  return `${base}/auth/action?${parsed.searchParams.toString()}`;
}

module.exports = { toAppActionLink };
