const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { db } = require('../firebase');

// GET api/finance/summary — коллекции lessons / expenses в Firestore
router.get('/summary', auth, async (req, res) => {
  try {
    const tutorId = req.user.id;

    const [lessonsSnap, expensesSnap] = await Promise.all([
      db.collection('lessons').where('tutor', '==', tutorId).get(),
      db.collection('expenses').where('tutor', '==', tutorId).get(),
    ]);

    let totalIncome = 0;
    let lessonCount = 0;
    lessonsSnap.forEach((doc) => {
      const d = doc.data();
      if (d.status !== 'completed') return;
      lessonCount += 1;
      totalIncome += Number(d.lesson_price) || 0;
    });

    let totalExpenses = 0;
    expensesSnap.forEach((doc) => {
      const d = doc.data();
      totalExpenses += Number(d.amount) || 0;
    });

    const netProfit = totalIncome - totalExpenses;

    res.json({
      totalIncome,
      totalExpenses,
      netProfit,
      lessonCount,
      expenseCount: expensesSnap.size,
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
