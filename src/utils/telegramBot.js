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
      return { ok: false, status: res.status, error: data.detail || data.message || res.statusText };
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

async function notifyPayment({ studentId, amountLabel, lessonsAdded, tutorName, rateUnit }) {
  return botFetch('/v1/notify/payment', {
    body: {
      student_id: studentId,
      amount_label: amountLabel || 'пополнение',
      lessons_added: Number(lessonsAdded) || 0,
      tutor_name: tutorName || null,
      rate_unit: rateUnit === 'lesson' ? 'lesson' : 'hour',
    },
  });
}

async function notifyBalance({ studentId, lessonsLeft, tutorName, rateUnit }) {
  return botFetch('/v1/notify/balance', {
    body: {
      student_id: studentId,
      lessons_left: Number(lessonsLeft) || 0,
      tutor_name: tutorName || null,
      rate_unit: rateUnit === 'lesson' ? 'lesson' : 'hour',
    },
  });
}

async function notifyLessonStart({ studentId, minutesBefore, timeLabel, meetingLink, tutorName }) {
  return botFetch('/v1/notify/lesson-start', {
    body: {
      student_id: studentId,
      minutes_before: Number(minutesBefore) || 30,
      time_label: timeLabel || '',
      meeting_link: meetingLink || null,
      tutor_name: tutorName || null,
    },
  });
}

async function notifyHomework({ studentId, text, tutorName }) {
  return botFetch('/v1/notify/homework', {
    body: {
      student_id: studentId,
      text: text || 'Домашка',
      tutor_name: tutorName || null,
    },
  });
}

async function notifyLessonMoved({ studentId, newTimeLabel, meetingLink, tutorName }) {
  return botFetch('/v1/notify/lesson-moved', {
    body: {
      student_id: studentId,
      new_time_label: newTimeLabel || '',
      meeting_link: meetingLink || null,
      tutor_name: tutorName || null,
    },
  });
}

async function unlinkStudent({ studentId }) {
  return botFetch('/v1/unlink', {
    body: { student_id: studentId },
  });
}

function withTelegramDeepLink(student) {
  if (!student || typeof student !== 'object') {
    return student;
  }
  const token = student.telegram_link_token;
  return {
    ...student,
    telegram_deep_link: token ? buildDeepLink(token) : student.telegram_deep_link || null,
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
