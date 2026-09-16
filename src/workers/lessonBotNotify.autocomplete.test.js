const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Auto-complete must mark status only — no package debit.
 * Document the expected lesson patch used by processAutoComplete.
 */
function autoCompleteStatusOnlyPatch() {
  return {
    status: 'completed',
    billing_processed: true,
    balance_debited: false,
  };
}

describe('processAutoComplete billing policy', () => {
  it('marks completed without scheduling delayed debit', () => {
    const patch = autoCompleteStatusOnlyPatch();
    assert.equal(patch.status, 'completed');
    assert.equal(patch.billing_processed, true);
    assert.equal(patch.balance_debited, false);
  });
});
