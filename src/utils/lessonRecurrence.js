const { RRule } = require('rrule');
const { normalizeLessonStatus } = require('./lessonSnapshot');

const RRULE_WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const BYDAY_TO_WEEKDAY = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
};

function parseRruleParts(rrule) {
  const parts = {};
  for (const segment of String(rrule).split(';')) {
    const [key, value] = segment.split('=');
    if (key && value) {
      parts[key.trim().toUpperCase()] = value.trim();
    }
  }
  return parts;
}

function parseByDayFromRrule(rrule) {
  const parts = parseRruleParts(rrule);
  if (!parts.BYDAY) {
    return [];
  }
  return parts.BYDAY.split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => RRULE_WEEKDAY_CODES.includes(part));
}

function parseUntilDate(rrule) {
  const parts = parseRruleParts(rrule);
  if (!parts.UNTIL) {
    return null;
  }
  const compact = parts.UNTIL.replace(/[^0-9]/g, '').slice(0, 8);
  if (compact.length !== 8) {
    return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function formatUntilForRrule(untilDate) {
  const compact = String(untilDate).replace(/-/g, '').slice(0, 8);
  return `UNTIL=${compact}T235959Z`;
}

function applyAnchorTime(date, anchor) {
  const next = new Date(date);
  next.setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), 0);
  return next;
}

function parseStartDate(startDate, anchor) {
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    const [y, m, d] = String(startDate).split('-').map(Number);
    return new Date(y, m - 1, d, anchor.getHours(), anchor.getMinutes(), 0, 0);
  }
  return new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
    anchor.getHours(),
    anchor.getMinutes(),
    0,
    0,
  );
}

function dayKeyFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildRule(lesson) {
  const recurring = lesson?.isRecurring === true || Boolean(lesson?.rrule);
  if (!recurring || !lesson?.rrule || !lesson?.scheduledAt) {
    return null;
  }
  const anchor = new Date(lesson.scheduledAt);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }
  const parts = parseRruleParts(lesson.rrule);
  const dtstart = parseStartDate(lesson.startDate, anchor);
  const options = {
    dtstart,
    interval: parts.INTERVAL ? Math.max(1, Number(parts.INTERVAL)) : 1,
  };

  const freq = (parts.FREQ ?? 'WEEKLY').toUpperCase();
  if (freq === 'DAILY') {
    options.freq = RRule.DAILY;
  } else if (freq === 'MONTHLY') {
    const monthDay = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) : dtstart.getDate();
    options.freq = RRule.MONTHLY;
    options.bymonthday = monthDay;
  } else {
    const byDay = parseByDayFromRrule(lesson.rrule);
    if (byDay.length === 0) {
      return null;
    }
    options.freq = RRule.WEEKLY;
    options.byweekday = byDay.map((code) => BYDAY_TO_WEEKDAY[code]);
  }

  if (parts.COUNT) {
    const count = Number(parts.COUNT);
    if (!Number.isNaN(count) && count > 0) {
      options.count = count;
    }
  }

  const untilDate = parseUntilDate(lesson.rrule);
  if (untilDate) {
    const [y, m, d] = untilDate.split('-').map(Number);
    options.until = new Date(y, m - 1, d, 23, 59, 59, 999);
  }

  return new RRule(options);
}

function endOfLocalDay(date) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

function filterOccurrenceDates(dates, lesson) {
  const exdates = new Set((lesson.exdates ?? []).map((item) => String(item).slice(0, 10)));
  return dates.filter((date) => !exdates.has(dayKeyFromDate(date)));
}

function statusForOccurrence(lesson, occurrenceDate) {
  const completed = new Set((lesson.completedDates ?? []).map((item) => String(item).slice(0, 10)));
  if (completed.has(occurrenceDate)) {
    return 'completed';
  }
  const masterStatus = normalizeLessonStatus(lesson.status);
  if (masterStatus === 'completed') {
    return 'scheduled';
  }
  return masterStatus;
}

function parseScheduledDate(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw.toDate === 'function') {
    return raw.toDate();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Эффективное время урока: scheduledAt или fallback на createdAt. */
function resolveEffectiveSchedule(lesson) {
  const direct = parseScheduledDate(lesson?.scheduledAt);
  if (direct) {
    return {
      scheduledAt: direct.toISOString(),
      scheduleDerived: false,
    };
  }
  const created = parseScheduledDate(lesson?.createdAt);
  if (!created) {
    return null;
  }
  return {
    scheduledAt: created.toISOString(),
    scheduleDerived: true,
  };
}

function lessonWithEffectiveSchedule(lesson) {
  const resolved = resolveEffectiveSchedule(lesson);
  if (!resolved) {
    return lesson;
  }
  return {
    ...lesson,
    scheduledAt: resolved.scheduledAt,
    scheduleDerived: resolved.scheduleDerived,
  };
}

function occurrenceInRange(date, rangeStart, rangeEnd) {
  return date >= rangeStart && date <= endOfLocalDay(rangeEnd);
}

/** Диапазон для развёртки вхождений (как в календаре). */
function financeOccurrenceRange(from, to, now = new Date()) {
  if (from || to) {
    const start = from ? new Date(from) : new Date(0);
    const end = to ? endOfLocalDay(new Date(to)) : endOfLocalDay(new Date(now.getFullYear() + 2, 11, 31));
    return { start, end };
  }
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 10);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 2);
  end.setMonth(11, 31);
  return { start, end: endOfLocalDay(end) };
}

function classifyFinanceOrphan(lesson) {
  const resolved = resolveEffectiveSchedule(lesson);
  if (!resolved) {
    return 'no_schedule';
  }
  const working = lessonWithEffectiveSchedule(lesson);
  const recurring = working.isRecurring === true || Boolean(working.rrule);
  if (recurring && working.rrule && !buildRule(working)) {
    return 'broken_recurrence';
  }
  return null;
}

/**
 * Вхождения урока для финансов — та же логика, что expandLessonsForRange в календаре.
 * Пустой массив = в периоде нет занятий, которое видно в расписании.
 */
function expandFinanceOccurrences(lesson, rangeStart, rangeEnd) {
  const resolved = resolveEffectiveSchedule(lesson);
  if (!resolved) {
    return [];
  }
  const working = lessonWithEffectiveSchedule(lesson);
  const scheduled = parseScheduledDate(working.scheduledAt);
  if (!scheduled) {
    return [];
  }

  const durationMinutes = Number(working.lesson_duration ?? 60);
  const duration =
    !Number.isNaN(durationMinutes) && durationMinutes > 0 ? durationMinutes : 60;
  const recurring = working.isRecurring === true || Boolean(working.rrule);

  if (!recurring || !working.rrule) {
    if (!occurrenceInRange(scheduled, rangeStart, rangeEnd)) {
      return [];
    }
    const occurrenceDate = dayKeyFromDate(scheduled);
    return [
      {
        occurrenceDate,
        scheduledAt: String(working.scheduledAt),
        status: normalizeLessonStatus(working.status),
        durationMinutes: duration,
        isRecurring: false,
        visibleInCalendar: true,
        scheduleDerived: resolved.scheduleDerived,
      },
    ];
  }

  const rule = buildRule(working);
  if (!rule) {
    return [];
  }

  const anchor = new Date(working.scheduledAt);
  const dates = filterOccurrenceDates(
    rule.between(rangeStart, endOfLocalDay(rangeEnd), true),
    working,
  );

  return dates.map((occurrence) => {
    const at = applyAnchorTime(occurrence, anchor);
    const occurrenceDate = dayKeyFromDate(occurrence);
    return {
      occurrenceDate,
      scheduledAt: at.toISOString(),
      status: statusForOccurrence(working, occurrenceDate),
      durationMinutes: duration,
      isRecurring: true,
      visibleInCalendar: true,
      scheduleDerived: resolved.scheduleDerived,
    };
  });
}

/** Интервалы scheduled урока (один или все вхождения серии) в диапазоне. */
function lessonOccurrenceIntervals(lesson, rangeStart, rangeEnd) {
  if (!lesson?.scheduledAt) {
    return [];
  }
  const duration = Number(lesson.lesson_duration) || 60;
  const durationMs = duration * 60_000;

  const recurring = lesson.isRecurring === true || Boolean(lesson.rrule);
  if (!recurring || !lesson.rrule) {
    const start = Date.parse(String(lesson.scheduledAt));
    if (Number.isNaN(start)) {
      return [];
    }
    return [{ start, end: start + durationMs }];
  }

  const rule = buildRule(lesson);
  if (!rule) {
    return [];
  }

  const anchor = new Date(lesson.scheduledAt);
  const dates = filterOccurrenceDates(
    rule.between(rangeStart, endOfLocalDay(rangeEnd), true),
    lesson,
  );
  return dates.map((occurrence) => {
    const at = applyAnchorTime(occurrence, anchor);
    const start = at.getTime();
    return { start, end: start + durationMs };
  });
}

function buildRruleFromForm({ freq, byDay, untilDate, startDate }) {
  if (!startDate) {
    return null;
  }
  const segments = [];
  if (freq === 'monthly') {
    const day = Number(String(startDate).slice(8, 10));
    segments.push('FREQ=MONTHLY', `BYMONTHDAY=${day}`);
  } else {
    const normalized = [...new Set((byDay ?? []).map((d) => String(d).toUpperCase()))].filter(
      (d) => RRULE_WEEKDAY_CODES.includes(d),
    );
    if (normalized.length === 0) {
      return null;
    }
    segments.push('FREQ=WEEKLY', `BYDAY=${normalized.join(',')}`);
  }
  if (untilDate && /^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
    segments.push(formatUntilForRrule(untilDate));
  }
  return segments.join(';');
}

function normalizeRecurrenceFields(body, scheduledAt) {
  const isRecurring = body.isRecurring === true;
  let rrule = null;

  if (isRecurring) {
    if (body.rrule) {
      rrule = String(body.rrule).trim();
    } else {
      rrule = buildRruleFromForm({
        freq: body.recurrenceFreq === 'monthly' ? 'monthly' : 'weekly',
        byDay: body.recurrenceByDay,
        untilDate: body.recurrenceUntil ?? body.untilDate ?? null,
        startDate: body.startDate,
      });
    }
  }

  let startDate =
    isRecurring && body.startDate ? String(body.startDate).trim().slice(0, 10) : null;

  if (isRecurring && !rrule) {
    return {
      isRecurring: false,
      rrule: null,
      startDate: null,
      exdates: [],
      completedDates: body.completedDates ?? [],
    };
  }

  if (isRecurring && !startDate && scheduledAt) {
    const anchor = new Date(scheduledAt);
    if (!Number.isNaN(anchor.getTime())) {
      startDate = dayKeyFromDate(anchor);
    }
  }

  return {
    isRecurring: Boolean(isRecurring && rrule),
    rrule: isRecurring && rrule ? rrule : null,
    startDate: isRecurring && startDate ? startDate : null,
    exdates: Array.isArray(body.exdates) ? body.exdates : undefined,
    completedDates: Array.isArray(body.completedDates) ? body.completedDates : undefined,
  };
}

module.exports = {
  parseByDayFromRrule,
  parseUntilDate,
  parseRruleParts,
  lessonOccurrenceIntervals,
  expandFinanceOccurrences,
  classifyFinanceOrphan,
  financeOccurrenceRange,
  resolveEffectiveSchedule,
  lessonWithEffectiveSchedule,
  normalizeRecurrenceFields,
  buildRule,
  buildRruleFromForm,
  dayKeyFromDate,
};
