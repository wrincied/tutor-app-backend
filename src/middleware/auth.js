const { admin } = require('../firebase');
const { isDisposableEmail } = require('../utils/disposableEmailDomain');

async function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Токен отсутствует' });
  }

  const token = header.split(' ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (isDisposableEmail(decoded.email)) {
      return res.status(403).json({
        message: 'Disposable email domains are not allowed',
      });
    }
    req.authToken = decoded;
    req.user = {
      id: decoded.uid,
      email: decoded.email || null,
      email_verified: decoded.email_verified === true,
    };
    next();
  } catch (_err) {
    return res.status(401).json({ message: 'Токен недействителен или истёк' });
  }
}

module.exports = auth;
