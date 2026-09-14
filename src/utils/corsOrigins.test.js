const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCorsOrigins, primaryFrontendUrl } = require('./corsOrigins');

describe('corsOrigins', () => {
  it('includes Firebase Hosting and GitHub Pages in default origins', () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const origins = parseCorsOrigins();
      assert.ok(origins.includes('https://simple4u-64822.web.app'));
      assert.ok(origins.includes('https://simple4u-64822.firebaseapp.com'));
      assert.ok(origins.includes('https://wrincied.github.io'));
    } finally {
      if (prev === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prev;
      }
    }
  });

  it('drops localhost in production but keeps GitHub Pages', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevUrl = process.env.FRONTEND_URL;
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL =
      'https://simple4u.at,https://wrincied.github.io,http://localhost:4200';
    try {
      const origins = parseCorsOrigins();
      assert.ok(origins.includes('https://simple4u.at'));
      assert.ok(origins.includes('https://wrincied.github.io'));
      assert.equal(origins.includes('http://localhost:4200'), false);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      if (prevUrl === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = prevUrl;
    }
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
      'https://simple4u.at,https://tutor-app--tutorassis.europe-west4.hosted.app';
    try {
      assert.equal(primaryFrontendUrl(), 'https://simple4u.at');
    } finally {
      if (prev === undefined) {
        delete process.env.FRONTEND_URL;
      } else {
        process.env.FRONTEND_URL = prev;
      }
    }
  });
});
