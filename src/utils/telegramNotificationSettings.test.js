const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldNotifyLowPackageBalance,
  normalizeTelegramSettings,
} = require('./telegramNotificationSettings');

test('shouldNotifyLowPackageBalance respects toggle and threshold', () => {
  const student = {
    billing_type: 'package',
    telegram_notification_settings: {
      low_balance_enabled: true,
      low_balance_threshold: 2,
    },
  };
  assert.equal(shouldNotifyLowPackageBalance(student, 2), true);
  assert.equal(shouldNotifyLowPackageBalance(student, 1), true);
  assert.equal(shouldNotifyLowPackageBalance(student, 3), false);
});

test('shouldNotifyLowPackageBalance skips when disabled or postpaid', () => {
  assert.equal(
    shouldNotifyLowPackageBalance(
      {
        billing_type: 'package',
        telegram_notification_settings: { low_balance_enabled: false, low_balance_threshold: 5 },
      },
      1,
    ),
    false,
  );
  assert.equal(
    shouldNotifyLowPackageBalance(
      {
        billing_type: 'postpaid',
        telegram_notification_settings: { low_balance_enabled: true, low_balance_threshold: 5 },
      },
      1,
    ),
    false,
  );
});

test('normalizeTelegramSettings defaults low_balance off / threshold 2', () => {
  const s = normalizeTelegramSettings({});
  assert.equal(s.low_balance_enabled, false);
  assert.equal(s.low_balance_threshold, 2);
});
