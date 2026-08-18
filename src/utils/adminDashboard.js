const { subscriptionLabel } = require('./userProfile');
const { getPlanPricing, getSubscriptionPricing, resolvePricingCountry } = require('./subscriptionPricing');
const { serializeDoc, serializeQuerySnapshot } = require('./serialize');

const MS_DAY = 24 * 60 * 60 * 1000;

const FINANCE_ADOPTION_ACTIONS = new Set([
  'expense.created',
  'expense.updated',
  'expense.deleted',
  'finance.export',
  'finance.export_pdf',
  'student.topup',
  'student.balance_adjust',
]);

function isAdminEmail(email) {
  return /^admin@/i.test(String(email || '').trim());
}

/**
 * KPI base: include_in_kpi not false, never admin@…, never unset super_admin.
 */
function isIncludedInKpi(data) {
  if (!data || typeof data !== 'object') {
    return false;
  }
  if (isAdminEmail(data.email)) {
    return false;
  }
  if (data.include_in_kpi === false) {
    return false;
  }
  if (data.include_in_kpi === true) {
    return true;
  }
  return data.role !== 'super_admin';
}

function expenseTutorId(data) {
  return String(data?.tutor || data?.tutor_id || '').trim();
}

function lessonTutorId(data) {
  return String(data?.tutor || data?.tutorId || data?.tutor_id || '').trim();
}

function roundTenthPercent(part, whole) {
  if (!whole) {
    return 0;
  }
  return Math.round((part / whole) * 1000) / 10;
}

function parseTs(value) {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function trialEndsMs(raw) {
  if (!raw) {
    return 0;
  }
  if (typeof raw.toDate === 'function') {
    return raw.toDate().getTime();
  }
  return parseTs(raw);
}

function buildStats(userDocs) {
  let totalUsers = 0;
  let paidUsers = 0;
  let basisUsers = 0;
  let proUsers = 0;
  let trialUsers = 0;
  const estimatedMrr = {};

  for (const doc of userDocs) {
    totalUsers += 1;
    const data = doc.data();
    const status = subscriptionLabel(data.subscription_status);
    if (status === 'basis' || status === 'pro') {
      paidUsers += 1;
      if (status === 'basis') {
        basisUsers += 1;
      } else {
        proUsers += 1;
      }
      try {
        const pricingCountry = resolvePricingCountry(data.tax_mode, data.country_settings);
        const pricing =
          status === 'basis'
            ? getPlanPricing('basis', pricingCountry)
            : getSubscriptionPricing(data.country_settings);
        const currency = pricing?.currency || 'EUR';
        const monthly = Number(pricing?.monthly) || 0;
        estimatedMrr[currency] = (estimatedMrr[currency] || 0) + monthly;
      } catch (err) {
        console.warn('[adminDashboard] MRR skip', doc.id, err?.message || err);
      }
    } else if (status === 'trial') {
      trialUsers += 1;
    }
  }

  const conversionPercent =
    totalUsers > 0 ? Math.round((paidUsers / totalUsers) * 1000) / 10 : 0;

  return {
    totalUsers,
    paidUsers,
    basisUsers,
    proUsers,
    trialUsers,
    conversionPercent,
    estimatedMrr,
  };
}

function buildSegments(userDocs, nowMs) {
  const ms7 = 7 * MS_DAY;
  const ms14 = 14 * MS_DAY;
  const ms7Ahead = nowMs + ms7;

  let active7d = 0;
  let inactive14d = 0;
  let trialExpiring7d = 0;
  let onboardingIncomplete = 0;
  let emailUnverified = 0;

  for (const doc of userDocs) {
    const data = doc.data();
    const lastLogin = parseTs(
      typeof data.last_login_at?.toDate === 'function'
        ? data.last_login_at.toDate().toISOString()
        : data.last_login_at,
    );

    if (lastLogin && nowMs - lastLogin <= ms7) {
      active7d += 1;
    }
    if (!lastLogin || nowMs - lastLogin >= ms14) {
      inactive14d += 1;
    }
    if (data.onboarding_completed !== true) {
      onboardingIncomplete += 1;
    }
    if (data.email_verified !== true) {
      emailUnverified += 1;
    }

    if (subscriptionLabel(data.subscription_status) === 'trial') {
      const ends = trialEndsMs(data.trial_ends_at);
      if (ends && ends >= nowMs && ends <= ms7Ahead) {
        trialExpiring7d += 1;
      }
    }
  }

  return { active7d, inactive14d, trialExpiring7d, onboardingIncomplete, emailUnverified };
}

function buildFunnel(userDocs, tutorsWithStudent, tutorsWithLesson, nowMs) {
  const ms14 = 14 * MS_DAY;
  let registered = userDocs.length;
  let emailVerified = 0;
  let onboardingDone = 0;
  let hasStudent = 0;
  let hasLesson = 0;
  let activeWeek2 = 0;

  for (const doc of userDocs) {
    const data = doc.data();
    if (data.email_verified === true) {
      emailVerified += 1;
    }
    if (data.onboarding_completed === true) {
      onboardingDone += 1;
    }
    if (tutorsWithStudent.has(doc.id)) {
      hasStudent += 1;
    }
    if (tutorsWithLesson.has(doc.id)) {
      hasLesson += 1;
    }

    const created = parseTs(
      typeof data.createdAt?.toDate === 'function'
        ? data.createdAt.toDate().toISOString()
        : data.createdAt,
    );
    const lastLogin = parseTs(
      typeof data.last_login_at?.toDate === 'function'
        ? data.last_login_at.toDate().toISOString()
        : data.last_login_at,
    );
    if (created && created <= nowMs - ms14 && lastLogin && nowMs - lastLogin <= 7 * MS_DAY) {
      activeWeek2 += 1;
    }
  }

  return {
    registered,
    emailVerified,
    onboardingDone,
    hasStudent,
    hasLesson,
    activeWeek2,
  };
}

function buildAlerts(userDocs, emailById, nowMs) {
  const ms3 = 3 * MS_DAY;
  const ms7 = 7 * MS_DAY;
  const ms30 = 30 * MS_DAY;
  const alerts = [];

  for (const doc of userDocs) {
    const data = doc.data();
    const email = emailById.get(doc.id) || doc.id;
    const status = subscriptionLabel(data.subscription_status);
    const ends = trialEndsMs(data.trial_ends_at);
    const lastLogin = parseTs(
      typeof data.last_login_at?.toDate === 'function'
        ? data.last_login_at.toDate().toISOString()
        : data.last_login_at,
    );

    if (status === 'trial' && ends) {
      if (ends < nowMs) {
        alerts.push({
          type: 'trial_expired',
          user_id: doc.id,
          email,
          trial_ends_at: new Date(ends).toISOString(),
        });
      } else if (ends - nowMs <= ms3) {
        alerts.push({
          type: 'trial_expiring_soon',
          user_id: doc.id,
          email,
          trial_ends_at: new Date(ends).toISOString(),
        });
      }
    }

    if (status === 'pro' && (!lastLogin || nowMs - lastLogin >= ms30)) {
      alerts.push({
        type: 'pro_inactive',
        user_id: doc.id,
        email,
        last_login_at: lastLogin ? new Date(lastLogin).toISOString() : null,
      });
    }
  }

  alerts.sort((left, right) => {
    const rank = { trial_expiring_soon: 0, trial_expired: 1, pro_inactive: 2 };
    return (rank[left.type] ?? 9) - (rank[right.type] ?? 9);
  });

  return alerts.slice(0, 30);
}

function buildGeography(userDocs) {
  const counts = new Map();
  for (const doc of userDocs) {
    const country = String(doc.data().country_settings || '—').trim().toUpperCase() || '—';
    counts.set(country, (counts.get(country) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);
}

async function buildProductUsage(db, userCount, nowMs, includedTutorIds) {
  const since7d = new Date(nowMs - 7 * MS_DAY).toISOString();
  const allow = includedTutorIds instanceof Set ? includedTutorIds : null;
  const tutorAllowed = (id) => Boolean(id) && (!allow || allow.has(id));

  const [studentsSnap, lessonsSnap, expensesSnap, activitySnap] = await Promise.all([
    db.collection('students').get(),
    db.collection('lessons').get(),
    db.collection('expenses').get(),
    db.collection('activity_logs').get(),
  ]);

  const tutorsWithStudent = new Set();
  let totalStudents = 0;
  studentsSnap.docs.forEach((doc) => {
    const tutorId = doc.data().tutor_id;
    if (!tutorAllowed(tutorId)) {
      return;
    }
    totalStudents += 1;
    tutorsWithStudent.add(tutorId);
  });

  const tutorsWithLesson = new Set();
  let lessonsLast7d = 0;
  lessonsSnap.docs.forEach((doc) => {
    const data = doc.data();
    const tutorId = lessonTutorId(data);
    if (!tutorAllowed(tutorId)) {
      return;
    }
    tutorsWithLesson.add(tutorId);
    const created = parseTs(
      typeof data.createdAt?.toDate === 'function'
        ? data.createdAt.toDate().toISOString()
        : data.createdAt,
    );
    if (created && created >= parseTs(since7d)) {
      lessonsLast7d += 1;
    }
  });

  const financeCandidates = new Set();
  expensesSnap.docs.forEach((doc) => {
    const tutorId = expenseTutorId(doc.data());
    if (tutorAllowed(tutorId)) {
      financeCandidates.add(tutorId);
    }
  });
  activitySnap.docs.forEach((doc) => {
    const data = doc.data();
    if (!FINANCE_ADOPTION_ACTIONS.has(String(data.action || ''))) {
      return;
    }
    const tutorId = String(data.tutor_id || data.tutor || '').trim();
    if (tutorAllowed(tutorId)) {
      financeCandidates.add(tutorId);
    }
  });

  const tutorsWithFinance = new Set(
    [...financeCandidates].filter((id) => tutorsWithLesson.has(id)),
  );

  const avgStudentsPerTutor =
    tutorsWithStudent.size > 0
      ? Math.round((totalStudents / tutorsWithStudent.size) * 10) / 10
      : 0;

  const coreUsers = tutorsWithLesson.size;
  const financeUsers = tutorsWithFinance.size;

  return {
    lessonsLast7d,
    totalStudents,
    avgStudentsPerTutor,
    tutorsWithFinance: financeUsers,
    financeUsersPercent: roundTenthPercent(financeUsers, coreUsers),
    coreActivationPercent: roundTenthPercent(coreUsers, userCount),
    tutorsWithStudent,
    tutorsWithLesson,
  };
}

async function buildAdminDashboard(db, { activityLimit = 40 } = {}) {
  const nowMs = Date.now();
  const usersSnap = await db.collection('users').get();
  const userDocs = usersSnap.docs;

  const emailById = new Map();
  userDocs.forEach((doc) => {
    emailById.set(doc.id, String(doc.data().email || '').trim());
  });

  const kpiDocs = userDocs.filter((doc) => isIncludedInKpi(doc.data()));
  const includedTutorIds = new Set(kpiDocs.map((doc) => doc.id));
  const product = await buildProductUsage(db, kpiDocs.length, nowMs, includedTutorIds);

  return {
    stats: buildStats(kpiDocs),
    segments: buildSegments(kpiDocs, nowMs),
    funnel: buildFunnel(kpiDocs, product.tutorsWithStudent, product.tutorsWithLesson, nowMs),
    alerts: buildAlerts(kpiDocs, emailById, nowMs),
    geography: buildGeography(kpiDocs),
    kpiCoverage: {
      included: kpiDocs.length,
      total: userDocs.length,
    },
    activation: {
      totalKpiUsers: kpiDocs.length,
      coreUsers: product.tutorsWithLesson.size,
      corePercent: product.coreActivationPercent,
      financeUsers: product.tutorsWithFinance,
      financePercent: product.financeUsersPercent,
    },
    productUsage: {
      lessonsLast7d: product.lessonsLast7d,
      totalStudents: product.totalStudents,
      avgStudentsPerTutor: product.avgStudentsPerTutor,
      tutorsWithFinance: product.tutorsWithFinance,
      financeUsersPercent: product.financeUsersPercent,
    },
  };
}

const DEFAULT_DASHBOARD_WIDGETS = [
  'kpi-total-users',
  'kpi-basis-users',
  'kpi-pro-users',
  'kpi-paid-users',
  'kpi-trial-users',
  'kpi-conversion',
  'kpi-mrr',
  'kpi-core-activation',
  'kpi-finance-adoption',
  'segments',
  'activation-funnel',
  'alerts',
  'last-visits',
  'geography',
  'product-usage',
];

const ALLOWED_DASHBOARD_WIDGETS = new Set(DEFAULT_DASHBOARD_WIDGETS);

function normalizeDashboardWidgets(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_DASHBOARD_WIDGETS];
  }
  const filtered = raw.filter((id) => ALLOWED_DASHBOARD_WIDGETS.has(String(id)));
  return filtered.length ? filtered : [...DEFAULT_DASHBOARD_WIDGETS];
}

module.exports = {
  buildAdminDashboard,
  isIncludedInKpi,
  isAdminEmail,
  expenseTutorId,
  lessonTutorId,
  roundTenthPercent,
  FINANCE_ADOPTION_ACTIONS,
  DEFAULT_DASHBOARD_WIDGETS,
  ALLOWED_DASHBOARD_WIDGETS,
  normalizeDashboardWidgets,
  parseTs,
};
