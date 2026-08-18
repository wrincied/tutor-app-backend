/**
 * After early-adopter yearly checkout: 1 cycle at 59.99, then standard yearly Price.
 * Stripe API 2025-09+ removed phases[].iterations — use end_date or duration.
 */

function addOneYearUnix(unix) {
  const d = new Date(Number(unix) * 1000);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}

function priceIdOf(item) {
  if (!item) {
    return null;
  }
  return typeof item.price === 'string' ? item.price : item.price?.id || null;
}

function scheduleAlreadyHasYearTwo(schedule, standardId) {
  const phase1 = schedule?.phases?.[1];
  if (!phase1 || !standardId) {
    return false;
  }
  return (phase1.items || []).some((item) => priceIdOf(item) === standardId);
}

function buildEarlyYearPhases(subscription, phase0, standardId) {
  const items = (phase0.items || [])
    .map((item) => {
      const price = priceIdOf(item);
      return price ? { price, quantity: item.quantity || 1 } : null;
    })
    .filter(Boolean);

  const trialEnd =
    subscription.status === 'trialing' && subscription.trial_end
      ? subscription.trial_end
      : null;

  const firstPhase = {
    items,
    start_date: phase0.start_date,
    proration_behavior: 'none',
    metadata: subscription.metadata || {},
  };
  if (trialEnd) {
    firstPhase.trial_end = trialEnd;
    firstPhase.end_date = addOneYearUnix(trialEnd);
  } else if (phase0.end_date) {
    firstPhase.end_date = phase0.end_date;
  } else {
    firstPhase.duration = { interval: 'year', interval_count: 1 };
  }

  return [
    firstPhase,
    {
      items: [{ price: standardId, quantity: 1 }],
      proration_behavior: 'none',
      metadata: { ...(subscription.metadata || {}), earlyYearly: '0' },
    },
  ];
}

/**
 * After early-adopter yearly checkout: 1 cycle at 59.99, then standard yearly Price.
 */
async function ensureEarlyYearSchedule(stripe, subscription) {
  if (!stripe || !subscription?.id) {
    return null;
  }
  if (String(subscription.metadata?.earlyYearly) !== '1') {
    return null;
  }
  const existing =
    typeof subscription.schedule === 'string'
      ? subscription.schedule
      : subscription.schedule?.id;
  const standardId = String(process.env.STRIPE_PRICE_ID_PRO_YEARLY || '').trim();
  if (!standardId) {
    console.warn('[billing] skip early schedule: STRIPE_PRICE_ID_PRO_YEARLY missing');
    return existing || null;
  }

  let createdByUs = false;
  let schedule;
  if (existing) {
    schedule = await stripe.subscriptionSchedules.retrieve(existing);
    if (scheduleAlreadyHasYearTwo(schedule, standardId)) {
      return schedule.id;
    }
  } else {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    });
    createdByUs = true;
  }

  const phase0 = schedule.phases?.[0];
  if (!phase0) {
    if (createdByUs) {
      await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
    }
    return createdByUs ? null : schedule.id;
  }

  try {
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      phases: buildEarlyYearPhases(subscription, phase0, standardId),
    });
  } catch (err) {
    if (createdByUs) {
      await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
    }
    throw err;
  }
  return schedule.id;
}

module.exports = {
  addOneYearUnix,
  buildEarlyYearPhases,
  ensureEarlyYearSchedule,
  scheduleAlreadyHasYearTwo,
};
