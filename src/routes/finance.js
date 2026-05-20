const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const { db } = require('../firebase');

function lessonIncome(lessonData) {
  if (lessonData.status !== 'completed') {
    return 0;
  }
  const durationMinutes = Number(lessonData.lesson_duration ?? 60);
  const hours = Math.max(0, durationMinutes) / 60;
  const snapshotRate = Number(lessonData.lesson_rate);
  if (!Number.isNaN(snapshotRate) && snapshotRate >= 0) {
    return snapshotRate * hours;
  }
  const fallbackPrice = Number(lessonData.lesson_price);
  return Number.isNaN(fallbackPrice) ? 0 : fallbackPrice;
}

function austrianIncomeTax(taxBase) {
  const brackets = [
    { limit: 12816, rate: 0.0 },
    { limit: 20818, rate: 0.2 },
    { limit: 34513, rate: 0.3 },
    { limit: 66612, rate: 0.41 },
    { limit: 99266, rate: 0.48 },
    { limit: Infinity, rate: 0.5 },
  ];
  let tax = 0;
  let previousLimit = 0;
  let rest = Math.max(0, taxBase);

  for (const bracket of brackets) {
    if (rest <= 0) {
      break;
    }
    const segmentCap = bracket.limit - previousLimit;
    const segment = Math.min(rest, segmentCap);
    tax += segment * bracket.rate;
    rest -= segment;
    previousLimit = bracket.limit;
  }

  return tax;
}

router.get('/summary', auth, async (req, res, next) => {
  try {
    const tutorId = req.user.id;
    const [lessonsSnap, expensesSnap] = await Promise.all([
      db.collection('lessons').where('tutor', '==', tutorId).get(),
      db.collection('expenses').where('tutor', '==', tutorId).get(),
    ]);

    let totalIncome = 0;
    let lessonCount = 0;
    let completedLessonCount = 0;
    let totalLessonHours = 0;

    lessonsSnap.forEach((doc) => {
      const data = doc.data();
      lessonCount += 1;
      if (data.status === 'completed') {
        completedLessonCount += 1;
      }
      const durationMinutes = Number(data.lesson_duration ?? 60);
      if (!Number.isNaN(durationMinutes) && durationMinutes > 0) {
        totalLessonHours += durationMinutes / 60;
      }
      totalIncome += lessonIncome(data);
    });

    let totalExpenses = 0;
    expensesSnap.forEach((doc) => {
      const amount = Number(doc.data().amount);
      totalExpenses += Number.isNaN(amount) ? 0 : amount;
    });

    const grossProfit = totalIncome - totalExpenses;

    // Austria-oriented estimation for self-employed tutor:
    const socialInsuranceRate = 0.1812;
    const socialInsurance = Math.max(0, grossProfit) * socialInsuranceRate;
    const taxableBase = Math.max(0, grossProfit - socialInsurance);
    const incomeTax = austrianIncomeTax(taxableBase);
    const netProfit = grossProfit - socialInsurance - incomeTax;

    // Employee model with 13th/14th salary (reference projection, not accounting advice):
    const monthlyEquivalentGross = Math.max(0, totalIncome / 12);
    const annualGross14 = monthlyEquivalentGross * 14;
    const annualSpecialSalary = monthlyEquivalentGross * 2;
    const annualRegularSalary = monthlyEquivalentGross * 12;
    const estimatedSpecialSalaryTax = annualSpecialSalary * 0.06;
    const estimatedRegularTax = austrianIncomeTax(annualRegularSalary);
    const annualEmployeeNetEstimate =
      annualGross14 - estimatedSpecialSalaryTax - estimatedRegularTax;

    res.json({
      currency: 'EUR',
      totals: {
        lessonCount,
        completedLessonCount,
        totalLessonHours,
        expenseCount: expensesSnap.size,
      },
      income: {
        totalIncome,
        totalExpenses,
        grossProfit,
      },
      austria: {
        socialInsuranceRate,
        socialInsurance,
        taxableBase,
        incomeTax,
        netProfit,
      },
      salaryModel13_14: {
        monthlyEquivalentGross,
        annualGross14,
        annualEmployeeNetEstimate,
        estimatedRegularTax,
        estimatedSpecialSalaryTax,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
