const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkoutSessionUserId,
  checkoutSessionBelongsToUser,
} = require('./checkoutSessionOwner');

describe('checkoutSessionOwner', () => {
  it('prefers client_reference_id over metadata', () => {
    assert.equal(
      checkoutSessionUserId({
        client_reference_id: 'uid-a',
        metadata: { userId: 'uid-b' },
      }),
      'uid-a',
    );
  });

  it('falls back to metadata.userId', () => {
    assert.equal(
      checkoutSessionUserId({ metadata: { userId: 'uid-b' } }),
      'uid-b',
    );
  });

  it('rejects sessions with no owner (cannot be claimed by a logged-in user)', () => {
    assert.equal(checkoutSessionBelongsToUser({}, 'uid-a'), false);
    assert.equal(checkoutSessionBelongsToUser({ metadata: {} }, 'uid-a'), false);
    assert.equal(
      checkoutSessionBelongsToUser({ client_reference_id: '   ' }, 'uid-a'),
      false,
    );
  });

  it('rejects a session owned by someone else', () => {
    assert.equal(
      checkoutSessionBelongsToUser({ client_reference_id: 'uid-a' }, 'uid-b'),
      false,
    );
  });

  it('accepts a matching owner', () => {
    assert.equal(
      checkoutSessionBelongsToUser({ client_reference_id: 'uid-a' }, 'uid-a'),
      true,
    );
  });
});
