const WORKSPACE_CURRENCIES = new Set(['EUR', 'USD', 'RUB', 'BYN']);
const WORKSPACE_DURATION_MIN = 5;
const WORKSPACE_DURATION_MAX = 480;
const REMINDER_OFFSET_MIN = 5;
const REMINDER_OFFSET_MAX = 7 * 24 * 60;
const BUILTIN_REMINDER_OFFSETS = new Set([15, 30, 60, 1440]);
const DEFAULT_WORKSPACE = {
  name: '',
  currency: 'EUR',
  defaultLessonDuration: 60,
  roundLessonPrices: false,
  customReminderOffsets: [],
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

function clampLessonDuration(raw) {
  const minutes = Math.round(Number(raw));
  if (!Number.isFinite(minutes)) {
    return DEFAULT_WORKSPACE.defaultLessonDuration;
  }
  return Math.min(WORKSPACE_DURATION_MAX, Math.max(WORKSPACE_DURATION_MIN, minutes));
}

function normalizeCustomReminderOffsets(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const unique = new Set();
  for (const item of raw) {
    const n = Math.round(Number(item));
    if (!Number.isFinite(n) || BUILTIN_REMINDER_OFFSETS.has(n)) {
      continue;
    }
    if (n < REMINDER_OFFSET_MIN || n > REMINDER_OFFSET_MAX) {
      continue;
    }
    unique.add(n);
  }
  return [...unique].sort((a, b) => a - b);
}

function normalizeWorkspace(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const currency = WORKSPACE_CURRENCIES.has(data.currency)
    ? data.currency
    : DEFAULT_WORKSPACE.currency;
  const defaultLessonDuration = clampLessonDuration(data.defaultLessonDuration);

  return {
    name: String(data.name ?? '').trim().slice(0, 120),
    currency,
    defaultLessonDuration,
    roundLessonPrices: data.roundLessonPrices === true,
    customReminderOffsets: normalizeCustomReminderOffsets(data.customReminderOffsets),
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

function dateKeyInTimeZone(date, timeZone) {
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(when);
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

function isDateInVacation(date, vacation, timeZone) {
  const settings = normalizeVacation(vacation);
  if (!settings.enabled || !settings.startDate || !settings.endDate) {
    return false;
  }
  const key = dateKeyInTimeZone(date, timeZone);
  if (!key) {
    return false;
  }
  return key >= settings.startDate && key <= settings.endDate;
}

/** Active vacation window for a tutor in their timezone. */
function resolveActiveVacation(vacation, timeZone, at = new Date()) {
  const settings = normalizeVacation(vacation);
  if (!isDateInVacation(at, settings, timeZone)) {
    return {
      active: false,
      message: '',
      startDate: '',
      endDate: '',
    };
  }
  return {
    active: true,
    message: settings.message,
    startDate: settings.startDate,
    endDate: settings.endDate,
  };
}

module.exports = {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKING_HOURS,
  DEFAULT_VACATION,
  normalizeWorkspace,
  normalizeWorkingHours,
  normalizeVacation,
  dateKeyInTimeZone,
  isDateInVacation,
  resolveActiveVacation,
};
