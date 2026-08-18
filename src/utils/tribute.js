const crypto = require('crypto');
const { getPlanPricing, toStripeUnitAmount } = require('./subscriptionPricing');
const { tributeCurrencyForCountry } = require('./paymentProvider');
const { resolveCheckoutOffer, tributePeriodAmounts } = require('./checkoutOffer');

const TRIBUTE_API = 'https://tribute.tg/api/v1';
const TRIBUTE_PRO_TRIAL = 'seven_days';

function getTributeApiKey() {
  return String(process.env.TRIBUTE_API_KEY || '').trim();
}

function getTributeShopId() {
  const raw = String(process.env.TRIBUTE_SHOP_ID || '').trim();
  if (!raw) {
    return null;
  }
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function isTributeConfigured() {
  return Boolean(getTributeApiKey());
}

function verifyTributeSignature(rawBody, signatureHeader) {
  const key = getTributeApiKey();
  const given = String(signatureHeader || '')
    .trim()
    .replace(/^sha256=/i, '');
  if (!key || !given || !rawBody) {
    return false;
  }
  const digest = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function buildTributeCheckoutAmount(plan, country, interval) {
  const tributeCurrency = tributeCurrencyForCountry(country);
  const pricingCountry = tributeCurrency === 'rub' ? 'RU' : 'AT';
  const pricing = getPlanPricing(plan, pricingCountry);
  const major = interval === 'yearly' ? pricing.yearly : pricing.monthly;
  return {
    currency: tributeCurrency,
    amount: toStripeUnitAmount(major, tributeCurrency),
    display: pricing,
  };
}

async function tributeRequest(pathname, { method = 'GET', body } = {}) {
  const apiKey = getTributeApiKey();
  if (!apiKey) {
    const err = new Error('Tribute is not configured (TRIBUTE_API_KEY)');
    err.status = 503;
    throw err;
  }
  const headers = { 'Api-Key': apiKey };
  /** @type {RequestInit} */
  const init = { method, headers };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${TRIBUTE_API}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.message || `Tribute API ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function createTributeShopOrder({
  plan,
  interval,
  country,
  userId,
  email,
  successUrl,
  failUrl,
  offer: offerArg,
}) {
  const tributeCurrency = tributeCurrencyForCountry(country);
  const pricingCountry = tributeCurrency === 'rub' ? 'RU' : 'AT';
  const offer = resolveCheckoutOffer(
    {
      tax_mode: pricingCountry === 'RU' ? 'ru-ip' : 'at-self-employed',
      country_settings: pricingCountry,
      isEarlyAdopter: offerArg?.earlyYearly === true,
      referredBy: offerArg?.referralPercent ? 'ref' : null,
    },
    { plan, interval },
  );
  const { currency, amount, firstPeriodAmount } = tributePeriodAmounts(offer);
  const shopId = getTributeShopId();
  const title = plan === 'basis' ? 'Simple4U Basis' : 'Simple4U Pro';
  const period = interval === 'yearly' ? 'yearly' : 'monthly';
  const payload = {
    currency,
    title,
    description: `${title} · ${period}`,
    amount,
    period,
    customerId: String(userId),
    email: email || undefined,
    successUrl,
    failUrl,
    comment: JSON.stringify({
      userId,
      plan,
      interval,
      country,
      earlyYearly: offer.earlyYearly,
      referralPercent: offer.referralPercent,
    }),
  };
  if (firstPeriodAmount != null) {
    payload.firstPeriodAmount = firstPeriodAmount;
  }
  if (shopId) {
    payload.shopId = shopId;
  }
  if (plan === 'pro') {
    payload.trialPeriod = TRIBUTE_PRO_TRIAL;
  }
  return tributeRequest('/shop/orders', { method: 'POST', body: payload });
}

async function cancelTributeShopOrder(orderUuid) {
  return tributeRequest(`/shop/orders/${encodeURIComponent(orderUuid)}/cancel`, {
    method: 'POST',
  });
}

module.exports = {
  TRIBUTE_PRO_TRIAL,
  getTributeApiKey,
  getTributeShopId,
  isTributeConfigured,
  verifyTributeSignature,
  buildTributeCheckoutAmount,
  createTributeShopOrder,
  cancelTributeShopOrder,
};
