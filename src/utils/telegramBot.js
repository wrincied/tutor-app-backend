const crypto = require('crypto');

function botConfig() {
  const baseUrl = (process.env.BOT_API_URL || '').replace(/\/$/, '');
  const secret = process.env.BOT_API_SECRET || '';
  const username = (process.env.BOT_USERNAME || 'simp1e4ubot').replace(/^@/, '');
  return { baseUrl, secret, username, enabled: Boolean(baseUrl && secret) };
}

function buildDeepLink(linkToken) {
  const { username } = botConfig();
  if (!linkToken) {
    return null;
  }
  return `https://t.me/${username}?start=${encodeURIComponent(linkToken)}`;
}

function newLinkToken() {
  return crypto.randomBytes(16).toString('hex');
}

function formatBotError(detail) {
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === 'object' && item.msg) {
          return String(item.msg);
        }
        return String(item);
      })
      .join('; ');
  }
  if (detail && typeof detail === 'object' && detail.message) {
    return String(detail.message);
  }
  return detail != null ? String(detail) : '';
}

async function botFetch(pathname, { method = 'POST', body } = {}) {
  const { baseUrl, secret, enabled } = botConfig();
  if (!enabled) {
    return { ok: false, skipped: true, error: 'bot_not_configured' };
  }
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': secret,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = formatBotError(data.detail || data.message) || res.statusText;
      return { ok: false, status: res.status, error };
    }
    // Notify endpoints return { ok: true|false, ... } in the body — unwrap it.
    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'ok')) {
      if (data.ok === false) {
        return {
          ok: false,
          error: data.error || 'unknown',
          detail: data.detail || null,
        };
      }
      return { ok: true, ...data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('telegramBot fetch:', err.message);
    return { ok: false, error: err.message };
  }
}

async function registerStudentLink({ studentId, linkToken, studentName, tutorName, botActive }) {
  return botFetch('/v1/links', {
    body: {
      student_id: studentId,
      link_token: linkToken,
      student_name: studentName || null,
      tutor_name: tutorName || null,
      bot_active: botActive !== false,
    },
  });
}

async function setBotActive({ studentId, botActive }) {
  return botFetch('/v1/bot-active', {
    body: {
      student_id: studentId,
      bot_active: Boolean(botActive),
    },
  });
}

async function notifyPayment({ studentId, amountLabel, lessonsAdded, tutorName, rateUnit, balanceAfter, paidAt, timezone }) {
  return botFetch('/v1/notify/payment', {
    body: {
      student_id: studentId,
      amount_label: amountLabel || 'пополнение',
      lessons_added: Number(lessonsAdded) || 0,
      tutor_name: tutorName || null,
      rate_unit: rateUnit === 'lesson' ? 'lesson' : 'hour',
      balance_after: balanceAfter != null && !Number.isNaN(Number(balanceAfter)) ? Number(balanceAfter) : null,
      paid_at: paidAt || null,
      timezone: timezone || null,
    },
  });
}

async function notifyBalance({
  studentId,
  lessonsLeft,
  tutorName,
  rateUnit,
  lessonsBefore,
  reason,
}) {
  const body = {
    student_id: studentId,
    lessons_left: Number(lessonsLeft) || 0,
    tutor_name: tutorName || null,
    rate_unit: rateUnit === 'lesson' ? 'lesson' : 'hour',
  };
  if (lessonsBefore !== undefined && lessonsBefore !== null && !Number.isNaN(Number(lessonsBefore))) {
    body.lessons_before = Number(lessonsBefore);
  }
  if (reason) {
    body.reason = String(reason);
  }
  return botFetch('/v1/notify/balance', { body });
}

async function notifyLessonStart({
  studentId,
  minutesBefore,
  timeLabel,
  meetingLink,
  tutorName,
  subject,
  scheduledAt,
  durationMinutes,
  timezone,
}) {
  return botFetch('/v1/notify/lesson-start', {
    body: {
      student_id: studentId,
      minutes_before: Number(minutesBefore) || 30,
      time_label: timeLabel || '',
      meeting_link: meetingLink || null,
      tutor_name: tutorName || null,
      subject: subject ? String(subject).trim().slice(0, 120) : null,
      scheduled_at: scheduledAt || null,
      duration_minutes: durationMinutes != null ? Number(durationMinutes) : 60,
      timezone: timezone || null,
    },
  });
}

async function notifyHomework({ studentId, text, tutorName }) {
  return botFetch('/v1/notify/homework', {
    body: {
      student_id: studentId,
      text: text || '',
      tutor_name: tutorName || null,
    },
  });
}

async function notifyLessonMoved({
  studentId,
  newTimeLabel,
  meetingLink,
  tutorName,
  subject,
  oldScheduledAt,
  newScheduledAt,
  timezone,
}) {
  return botFetch('/v1/notify/lesson-moved', {
    body: {
      student_id: studentId,
      new_time_label: newTimeLabel || '',
      meeting_link: meetingLink || null,
      tutor_name: tutorName || null,
      subject: subject ? String(subject).trim().slice(0, 120) : null,
      old_scheduled_at: oldScheduledAt || null,
      new_scheduled_at: newScheduledAt || null,
      timezone: timezone || null,
    },
  });
}

async function unlinkStudent({ studentId, notify = false, tutorName = null }) {
  return botFetch('/v1/unlink', {
    body: {
      student_id: studentId,
      notify: Boolean(notify),
      tutor_name: tutorName || null,
    },
  });
}

function withTelegramDeepLink(student) {
  if (!student || typeof student !== 'object') {
    return student;
  }
  const token = student.telegram_link_token;
  const parentToken = student.telegram_parent_link_token;
  return {
    ...student,
    telegram_deep_link: token ? buildDeepLink(token) : student.telegram_deep_link || null,
    telegram_parent_deep_link: parentToken
      ? buildDeepLink(parentToken)
      : student.telegram_parent_deep_link || null,
  };
}

module.exports = {
  botConfig,
  buildDeepLink,
  newLinkToken,
  registerStudentLink,
  setBotActive,
  unlinkStudent,
  notifyPayment,
  notifyBalance,
  notifyLessonStart,
  notifyHomework,
  notifyLessonMoved,
  withTelegramDeepLink,
};
