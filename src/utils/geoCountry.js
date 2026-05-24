const { normalizeCountryCode, DEFAULT_COUNTRY } = require('./subscriptionPricing');

const HEADER_COUNTRY_KEYS = [
  'cf-ipcountry',
  'x-vercel-ip-country',
  'cloudfront-viewer-country',
  'x-country-code',
];

function countryFromHeaders(req) {
  if (!req?.headers) {
    return null;
  }
  for (const key of HEADER_COUNTRY_KEYS) {
    const raw = req.headers[key];
    if (!raw || String(raw).trim() === 'XX') {
      continue;
    }
    const normalized = normalizeCountryCode(raw);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) {
      return first;
    }
  }
  return req.socket?.remoteAddress || req.ip || null;
}

/**
 * Определение страны по IP / CDN-заголовкам (для цены подписки).
 */
async function resolveCountryFromRequest(req) {
  const fromHeader = countryFromHeaders(req);
  if (fromHeader) {
    return { country: fromHeader, source: 'header' };
  }

  const ip = clientIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.')) {
    return { country: DEFAULT_COUNTRY, source: 'default' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(
      `https://ipapi.co/${encodeURIComponent(ip)}/country/`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);
    if (response.ok) {
      const text = (await response.text()).trim();
      const normalized = normalizeCountryCode(text);
      if (normalized) {
        return { country: normalized, source: 'ip' };
      }
    }
  } catch {
    /* fallback below */
  }

  return { country: DEFAULT_COUNTRY, source: 'default' };
}

module.exports = {
  resolveCountryFromRequest,
  countryFromHeaders,
  clientIp,
};
