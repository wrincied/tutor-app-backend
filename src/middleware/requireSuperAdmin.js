const { db } = require('../firebase');
const {
  parseEmailAllowlist,
  parseUidAllowlist,
} = require('../utils/adminAllowlist');

/**
 * After auth middleware: GitHub provider + (email allowlist OR uid allowlist) + super_admin.
 * No Firebase email verification / Identity Platform MFA required.
 */
async function requireSuperAdmin(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) {
      return res.status(401).json({ message: 'Unauthorized', code: 'NO_USER' });
    }

    const decoded = req.authToken || {};
    const email = String(decoded.email || req.user.email || '')
      .trim()
      .toLowerCase();
    const provider = String(decoded.firebase?.sign_in_provider || '');

    if (provider !== 'github.com') {
      return res.status(403).json({
        message: 'Admin access requires GitHub sign-in',
        code: 'GITHUB_REQUIRED',
      });
    }

    const emails = parseEmailAllowlist();
    const uids = parseUidAllowlist();
    if (emails.size === 0 && uids.size === 0) {
      console.error(
        '[requireSuperAdmin] Set ADMIN_GITHUB_EMAILS and/or ADMIN_GITHUB_UIDS',
      );
      return res.status(403).json({
        message: 'Admin allowlist is not configured',
        code: 'ALLOWLIST_NOT_CONFIGURED',
      });
    }

    const emailOk = email && emails.has(email);
    const uidOk = uids.has(uid);
    if (!emailOk && !uidOk) {
      console.warn(
        `[requireSuperAdmin] NOT_ALLOWLISTED uid=${uid} email=${email || '(none)'} provider=${provider}`,
      );
      return res.status(403).json({
        message: 'Forbidden',
        code: 'NOT_ALLOWLISTED',
      });
    }

    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) {
      return res.status(403).json({ message: 'Forbidden', code: 'NOT_SUPER_ADMIN' });
    }
    const role = String(snap.data().role ?? 'tutor').trim();
    if (role !== 'super_admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'NOT_SUPER_ADMIN' });
    }

    req.user.role = role;
    req.user.email = email;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = requireSuperAdmin;
