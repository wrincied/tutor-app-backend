const { isAdminAllowlisted } = require('../utils/adminAllowlist');

function requireVerifiedEmail(req, res, next) {
  // Allowlisted GitHub admins: Firebase Auth emailVerified is often false
  // even when the account is trusted via ADMIN_GITHUB_UIDS.
  if (isAdminAllowlisted(req.user?.id)) {
    return next();
  }

  if (!req.user?.email_verified) {
    return res.status(403).json({
      message: 'Необходимо подтвердить Email',
      code: 'EMAIL_NOT_VERIFIED',
      email: req.user?.email || null,
    });
  }
  next();
}

module.exports = requireVerifiedEmail;
