const WORKSPACE_CURRENCIES = new Set(['EUR', 'USD', 'RUB', 'BYN']);
const WORKSPACE_DURATIONS = new Set([45, 60, 90]);
const DEFAULT_WORKSPACE = {
  name: '',
  currency: 'EUR',
  defaultLessonDuration: 60,
};
const DEFAULT_WORKING_HOURS = {
  start: '08:00',
  end: '21:00',
  days: [1, 2, 3, 4, 5],
};

function parseHourToken(value) {
  const match = /^(\d{1,2}):00$/.exec(String(value ?? '').trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

function normalizeWorkspace(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const currency = WORKSPACE_CURRENCIES.has(data.currency)
    ? data.currency
    : DEFAULT_WORKSPACE.currency;
  const duration = Number(data.defaultLessonDuration);
  const defaultLessonDuration = WORKSPACE_DURATIONS.has(duration)
    ? duration
    : DEFAULT_WORKSPACE.defaultLessonDuration;

  return {
    name: String(data.name ?? '').trim().slice(0, 120),
    currency,
    defaultLessonDuration,
  };
}

function normalizeWorkingHours(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  let start = parseHourToken(data.start);
  let end = parseHourToken(data.end);
  if (start === null) {
    start = parseHourToken(DEFAULT_WORKING_HOURS.start);
  }
  if (end === null) {
    end = parseHourToken(DEFAULT_WORKING_HOURS.end);
  }
  if (end <= start) {
    start = parseHourToken(DEFAULT_WORKING_HOURS.start);
    end = parseHourToken(DEFAULT_WORKING_HOURS.end);
  }

  const daysRaw = Array.isArray(data.days) ? data.days : DEFAULT_WORKING_HOURS.days;
  const days = [...new Set(daysRaw.map((d) => Number(d)).filter((d) => d >= 1 && d <= 7))].sort(
    (a, b) => a - b,
  );

  return {
    start: `${String(start).padStart(2, '0')}:00`,
    end: `${String(end).padStart(2, '0')}:00`,
    days: days.length > 0 ? days : [...DEFAULT_WORKING_HOURS.days],
  };
}

module.exports = {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKING_HOURS,
  normalizeWorkspace,
  normalizeWorkingHours,
};
