const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isIncludedInKpi,
  isAdminEmail,
  expenseTutorId,
  lessonTutorId,
  roundTenthPercent,
  FINANCE_ADOPTION_ACTIONS,
} = require('./adminDashboard');

describe('isIncludedInKpi', () => {
  it('includes ordinary tutors by default', () => {
    assert.equal(isIncludedInKpi({ email: 'tutor@example.com' }), true);
  });

  it('excludes admin@ addresses even if include_in_kpi is true', () => {
    assert.equal(isAdminEmail('admin@simple4u.at'), true);
    assert.equal(isAdminEmail('Admin@example.com'), true);
    assert.equal(
      isIncludedInKpi({ email: 'admin@simple4u.at', include_in_kpi: true }),
      false,
    );
  });

  it('excludes super_admin until explicitly included', () => {
    assert.equal(isIncludedInKpi({ role: 'super_admin', email: 'owner@gmail.com' }), false);
    assert.equal(
      isIncludedInKpi({ role: 'super_admin', email: 'owner@gmail.com', include_in_kpi: true }),
      true,
    );
  });

  it('honours explicit include_in_kpi false', () => {
    assert.equal(isIncludedInKpi({ include_in_kpi: false, email: 'a@b.c' }), false);
  });
});

describe('tutor id fields', () => {
  it('reads expense tutor', () => {
    assert.equal(expenseTutorId({ tutor: 'uid-1' }), 'uid-1');
    assert.equal(expenseTutorId({ tutor_id: 'uid-2' }), 'uid-2');
  });

  it('reads lesson tutor / tutorId / tutor_id', () => {
    assert.equal(lessonTutorId({ tutor: 'uid-a' }), 'uid-a');
    assert.equal(lessonTutorId({ tutorId: 'uid-b' }), 'uid-b');
    assert.equal(lessonTutorId({ tutor_id: 'uid-c' }), 'uid-c');
  });
});

describe('activation percents', () => {
  it('rounds to one decimal', () => {
    assert.equal(roundTenthPercent(1, 3), 33.3);
    assert.equal(roundTenthPercent(0, 10), 0);
    assert.equal(roundTenthPercent(5, 0), 0);
  });

  it('treats export and manual billing as finance adoption actions', () => {
    assert.equal(FINANCE_ADOPTION_ACTIONS.has('finance.export'), true);
    assert.equal(FINANCE_ADOPTION_ACTIONS.has('student.topup'), true);
    assert.equal(FINANCE_ADOPTION_ACTIONS.has('student.balance_adjust'), true);
    assert.equal(FINANCE_ADOPTION_ACTIONS.has('expense.created'), true);
  });
});
