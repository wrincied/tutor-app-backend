const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isCompletedStatus,
  isMissedOrCanceledStatus,
} = require('./lessonBilling');

describe('lessonBilling', () => {
  it('detects completed status', () => {
    assert.equal(isCompletedStatus('completed'), true);
    assert.equal(isCompletedStatus('scheduled'), false);
  });

  it('detects missed or canceled status', () => {
    assert.equal(isMissedOrCanceledStatus('missed'), true);
    assert.equal(isMissedOrCanceledStatus('canceled'), true);
    assert.equal(isMissedOrCanceledStatus('cancelled'), true);
    assert.equal(isMissedOrCanceledStatus('scheduled'), false);
  });
});
