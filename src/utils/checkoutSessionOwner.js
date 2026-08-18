/**
 * Stripe Checkout sessions must name the paying tutor.
 * Empty client_reference_id + metadata.userId must never fall through to the caller.
 */
function checkoutSessionUserId(session) {
  return (
    String(session?.client_reference_id || '').trim() ||
    String(session?.metadata?.userId || '').trim()
  );
}

function checkoutSessionBelongsToUser(session, uid) {
  const owner = checkoutSessionUserId(session);
  const userId = String(uid || '').trim();
  return Boolean(owner) && Boolean(userId) && owner === userId;
}

module.exports = {
  checkoutSessionUserId,
  checkoutSessionBelongsToUser,
};
