const { db } = require('../firebase');
const { isAdminAllowlistedEmail } = require('../utils/brandEmail');

/**
 * After auth middleware: password provider + admin email allowlist + super_admin.
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

    if (provider !== 'password') {
      return res.status(403).json({
        message: 'Admin access requires email/password sign-in',
        code: 'PASSWORD_REQUIRED',
      });
    }

    if (!isAdminAllowlistedEmail(email)) {
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
