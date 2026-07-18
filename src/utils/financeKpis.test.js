const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeTaxProjection, PL_RYCZALT_RATE, RU_USN_RATE } = require('./financeTax');
const {
  lessonIncomeFromSnapshot,
  lessonScheduledRevenueFromSnapshot,
} = require('./lessonSnapshot');

/**
 * Mirrors /finance/summary KPI aggregation for Income / Expenses / Gross / Net.
 * Income card shows combinedIncome; Gross uses only completed income.
 */
function computeFinanceKpis({
  completedLessons,
  scheduledLessons,
  expenses,
  taxMode = 'at-self-employed',
}) {
  let totalIncome = 0;
  let scheduledIncome = 0;

  for (const lesson of completedLessons) {
    totalIncome += lessonIncomeFromSnapshot({ ...lesson, status: 'completed' });
  }
  for (const lesson of scheduledLessons) {
    scheduledIncome += lessonScheduledRevenueFromSnapshot({ ...lesson, status: 'scheduled' });
  }

  const totalExpenses = expenses.reduce((sum, amount) => sum + amount, 0);
  const combinedIncome = totalIncome + scheduledIncome;
  const grossProfit = totalIncome - totalExpenses;
  const tax = computeTaxProjection(taxMode, { grossProfit, totalIncome });

  return {
    totalIncome,
    scheduledIncome,
    combinedIncome,
    totalExpenses,
    grossProfit,
    tax,
    netProfit: tax?.netProfit ?? grossProfit,
    socialInsurance: tax?.socialInsurance ?? 0,
    incomeTax: tax?.incomeTax ?? 0,
  };
}

describe('finance KPIs: Income, Expenses, Gross, Net', () => {
  it('Income (Поступление) = completed + planned lesson revenue', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [{ lesson_price: 40, lesson_duration: 60 }],
      scheduledLessons: [{ lesson_price: 50, lesson_duration: 60 }],
      expenses: [],
    });

    assert.equal(kpis.totalIncome, 40);
    assert.equal(kpis.scheduledIncome, 50);
    assert.equal(kpis.combinedIncome, 90);
  });

  it('Expenses (Траты) sum expense amounts in report currency', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [],
      scheduledLessons: [],
      expenses: [25.5, 10, 4.5],
    });

    assert.equal(kpis.totalExpenses, 40);
  });

  it('Gross (Брутто) = completed income − expenses (planned excluded)', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [
        { lesson_price: 40, lesson_duration: 60 },
        { lesson_price: 60, lesson_duration: 60 },
      ],
      scheduledLessons: [{ lesson_price: 100, lesson_duration: 60 }],
      expenses: [30, 20],
    });

    assert.equal(kpis.totalIncome, 100);
    assert.equal(kpis.scheduledIncome, 100);
    assert.equal(kpis.combinedIncome, 200);
    assert.equal(kpis.totalExpenses, 50);
    assert.equal(kpis.grossProfit, 50);
    assert.notEqual(kpis.grossProfit, kpis.combinedIncome - kpis.totalExpenses);
  });

  it('Net (Нетто) = Gross − social insurance − income tax (AT self-employed)', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [{ lesson_price: 20000, lesson_duration: 60 }],
      scheduledLessons: [],
      expenses: [],
    });

    assert.equal(kpis.grossProfit, 20000);
    assert.equal(kpis.socialInsurance, 20000 * 0.1812);
    assert.equal(
      kpis.netProfit,
      kpis.grossProfit - kpis.socialInsurance - kpis.incomeTax,
    );
    assert.ok(kpis.netProfit < kpis.grossProfit);
  });

  it('PL / RU / BY / KZ modes each return a net estimate', () => {
    const base = {
      completedLessons: [{ lesson_price: 10000, lesson_duration: 60 }],
      scheduledLessons: [],
      expenses: [1000],
    };
    const pl = computeFinanceKpis({ ...base, taxMode: 'pl-ryczalt' });
    assert.equal(pl.incomeTax, 10000 * PL_RYCZALT_RATE);
    assert.equal(pl.netProfit, 9000 - 10000 * PL_RYCZALT_RATE);

    const ru = computeFinanceKpis({ ...base, taxMode: 'ru-usn' });
    assert.equal(ru.incomeTax, 10000 * RU_USN_RATE);

    const by = computeFinanceKpis({ ...base, taxMode: 'by-ip' });
    assert.equal(by.tax.mode, 'by-ip');
    assert.ok(by.netProfit < by.grossProfit);

    const kz = computeFinanceKpis({ ...base, taxMode: 'kz-ip' });
    assert.equal(kz.tax.mode, 'kz-ip');
    assert.ok(kz.netProfit < kz.grossProfit);

    const de = computeFinanceKpis({
      completedLessons: [{ lesson_price: 30000, lesson_duration: 60 }],
      scheduledLessons: [],
      expenses: [1000],
      taxMode: 'de-kleinunternehmer',
    });
    assert.equal(de.socialInsurance, 0);
    assert.ok(de.incomeTax > 0);
    assert.ok(de.netProfit < de.grossProfit);
  });

  it('hourly lessons scale income by duration before Gross/Net', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [{ lesson_price: 40, lesson_duration: 90, price_mode: 'hourly' }],
      scheduledLessons: [],
      expenses: [15],
    });

    assert.equal(kpis.totalIncome, 60);
    assert.equal(kpis.grossProfit, 45);
  });

  it('fixed price_mode ignores duration for Gross', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [{ lesson_price: 40, lesson_duration: 90, price_mode: 'fixed' }],
      scheduledLessons: [],
      expenses: [10],
    });

    assert.equal(kpis.totalIncome, 40);
    assert.equal(kpis.grossProfit, 30);
  });

  it('negative Gross when expenses exceed completed income; Net follows Gross', () => {
    const kpis = computeFinanceKpis({
      completedLessons: [{ lesson_price: 20, lesson_duration: 60 }],
      scheduledLessons: [{ lesson_price: 500, lesson_duration: 60 }],
      expenses: [100],
    });

    assert.equal(kpis.grossProfit, -80);
    assert.equal(kpis.socialInsurance, 0);
    assert.equal(kpis.incomeTax, 0);
    assert.equal(kpis.netProfit, -80);
  });
});
