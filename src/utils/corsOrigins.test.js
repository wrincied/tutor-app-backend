const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCorsOrigins, primaryFrontendUrl } = require('./corsOrigins');

describe('corsOrigins', () => {
  it('includes Firebase Hosting site in default origins', () => {
    const origins = parseCorsOrigins();
    assert.ok(origins.includes('https://simple4u-64822.web.app'));
    assert.ok(origins.includes('https://simple4u-64822.firebaseapp.com'));
  });

  it('merges comma-separated FRONTEND_URL with defaults', () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://example.com,https://app.example.com';
    try {
      const origins = parseCorsOrigins();
      assert.ok(origins.includes('https://example.com'));
      assert.ok(origins.includes('https://app.example.com'));
      assert.ok(origins.includes('http://localhost:4200'));
    } finally {
      if (prev === undefined) {
        delete process.env.FRONTEND_URL;
      } else {
        process.env.FRONTEND_URL = prev;
      }
    }
  });

  it('uses first FRONTEND_URL entry for redirects', () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL =
      'https://simple4u-64822.web.app,https://tutor-app--tutorassis.europe-west4.hosted.app';
    try {
      assert.equal(primaryFrontendUrl(), 'https://simple4u-64822.web.app');
    } finally {
      if (prev === undefined) {
        delete process.env.FRONTEND_URL;
      } else {
        process.env.FRONTEND_URL = prev;
      }
    }
  });
});
