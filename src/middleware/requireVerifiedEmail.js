function requireVerifiedEmail(req, res, next) {
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
