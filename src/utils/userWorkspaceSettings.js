const WORKSPACE_CURRENCIES = new Set(['EUR', 'USD', 'RUB', 'BYN']);
const WORKSPACE_DURATIONS = new Set([45, 60, 90, 120]);
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
const DEFAULT_VACATION = {
  enabled: false,
  startDate: '',
  endDate: '',
  message: '',
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDateToken(value) {
  const raw = String(value ?? '').trim();
  if (!DATE_RE.test(raw)) {
    return '';
  }
  const time = Date.parse(`${raw}T12:00:00`);
  return Number.isFinite(time) ? raw : '';
}

function normalizeVacation(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  let startDate = normalizeDateToken(data.startDate);
  let endDate = normalizeDateToken(data.endDate);
  if (startDate && endDate && endDate < startDate) {
    const swap = startDate;
    startDate = endDate;
    endDate = swap;
  }
  return {
    enabled: data.enabled === true,
    startDate,
    endDate,
    message: String(data.message ?? '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, 500),
  };
}

module.exports = {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKING_HOURS,
  DEFAULT_VACATION,
  normalizeWorkspace,
  normalizeWorkingHours,
  normalizeVacation,
};
