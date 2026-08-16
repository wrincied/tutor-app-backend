const express = require('express');
const { db, FieldValue } = require('../firebase');
const { verifyTributeSignature, isTributeConfigured } = require('../utils/tribute');

const router = express.Router();

function parseComment(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function extractShopEvent(body) {
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : body || {};
  const order = payload.order && typeof payload.order === 'object' ? payload.order : payload;
  const name = String(body?.name || body?.event || payload.name || '').toLowerCase();
  const comment = parseComment(order.comment || payload.comment);
  return {
    name,
    uuid: String(order.uuid || payload.uuid || payload.orderUuid || '').trim(),
    customerId: String(
      order.customerId || payload.customerId || comment.userId || '',
    ).trim(),
    status: String(order.status || payload.status || '').toLowerCase(),
    memberStatus: String(order.memberStatus || payload.memberStatus || '').toLowerCase(),
    memberInTrial: order.memberInTrial === true || payload.memberInTrial === true,
    memberExpiresAt: order.memberExpiresAt || payload.memberExpiresAt || null,
    memberTrialEndsAt: order.memberTrialEndsAt || payload.memberTrialEndsAt || null,
    plan: comment.plan === 'basis' ? 'basis' : 'pro',
    interval: comment.interval === 'yearly' ? 'yearly' : 'monthly',
  };
}

async function applyTributeToUser(event) {
  const userId = event.customerId;
  if (!userId) {
    console.warn('[tributeWebhook] skip: no customerId', event.name, event.uuid);
    return false;
  }
  const userRef = db.collection('users').doc(userId);
  const snap = await userRef.get();
  if (!snap.exists) {
    console.warn('[tributeWebhook] user missing', userId);
    return false;
  }

  const paid =
    event.name.includes('payment_received') ||
    event.name.includes('paymentreceived') ||
    event.name.includes('charge_success') ||
    event.name.includes('chargesuccess') ||
    event.status === 'paid';
  const cancelled =
    event.name.includes('cancel') || event.memberStatus === 'cancelled';
  const refunded = event.name.includes('refund');

  const patch = {
    billing_provider: 'tribute',
    subscription_updated_at: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (event.uuid) {
    patch.tribute_order_uuid = event.uuid;
  }

  if (refunded) {
    patch.subscription_status = 'free';
    patch.trial_ends_at = null;
    patch.cancel_at_period_end = false;
    patch.subscription_cancel_at = null;
  } else if (cancelled && !paid) {
    patch.cancel_at_period_end = true;
    patch.subscription_cancel_at = event.memberExpiresAt
      ? new Date(event.memberExpiresAt).toISOString()
      : null;
  } else if (paid || event.memberStatus === 'active') {
    if (event.memberInTrial) {
      patch.subscription_status = 'trial';
      patch.trial_ends_at = event.memberTrialEndsAt
        ? new Date(event.memberTrialEndsAt).toISOString()
        : null;
    } else {
      patch.subscription_status = event.plan === 'basis' ? 'basis' : 'pro';
      patch.trial_ends_at = null;
    }
    patch.cancel_at_period_end = event.memberStatus === 'cancelled';
    patch.subscription_cancel_at =
      event.memberStatus === 'cancelled' && event.memberExpiresAt
        ? new Date(event.memberExpiresAt).toISOString()
        : null;
  } else {
    console.log('[tributeWebhook] ignored event', event.name, event.status);
    return false;
  }

  await userRef.update(patch);
  console.log('[tributeWebhook] applied', {
    userId,
    name: event.name,
    status: patch.subscription_status ?? '(flags only)',
    uuid: event.uuid,
  });
  return true;
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    if (!isTributeConfigured()) {
      return res.status(503).json({ message: 'Tribute webhook not configured' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const signature = req.headers['trbt-signature'] || req.headers['Trbt-Signature'];
    if (!verifyTributeSignature(raw, signature)) {
      return res.status(400).json({ message: 'Invalid Tribute signature' });
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return res.status(400).json({ message: 'Invalid JSON' });
    }
    const event = extractShopEvent(body);
    console.log('[tributeWebhook] event', event.name, event.uuid);
    await applyTributeToUser(event);
    res.json({ received: true });
  } catch (error) {
    console.error('[tributeWebhook] error', error);
    next(error);
  }
});

module.exports = router;
module.exports.extractShopEvent = extractShopEvent;
module.exports.applyTributeToUser = applyTributeToUser;
