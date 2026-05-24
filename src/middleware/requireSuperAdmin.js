const { db } = require('../firebase');

/** После auth: только role === 'super_admin' в Firestore users/{uid}. */
async function requireSuperAdmin(req, res, next) {
  try {
    const snap = await db.collection('users').doc(req.user.id).get();
    if (!snap.exists) {
      return res.status(403).json({ message: 'Forbidden', code: 'NOT_SUPER_ADMIN' });
    }
    const role = String(snap.data().role ?? 'tutor').trim();
    if (role !== 'super_admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'NOT_SUPER_ADMIN' });
    }
    req.user.role = role;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = requireSuperAdmin;
