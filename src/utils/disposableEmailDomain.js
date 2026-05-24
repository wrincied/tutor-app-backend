const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'guerrillamail.com',
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
]);

function emailDomain(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return '';
  }
  return normalized.slice(atIndex + 1);
}

function isDisposableEmail(email) {
  const domain = emailDomain(email);
  return domain ? DISPOSABLE_EMAIL_DOMAINS.has(domain) : false;
}

module.exports = {
  DISPOSABLE_EMAIL_DOMAINS,
  emailDomain,
  isDisposableEmail,
};
