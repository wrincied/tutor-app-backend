const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isCompletedStatus } = require('./lessonBalance');

describe('lessonBalance', () => {
  it('detects completed status', () => {
    assert.equal(isCompletedStatus('completed'), true);
    assert.equal(isCompletedStatus('scheduled'), false);
    assert.equal(isCompletedStatus('cancelled'), false);
  });
});
