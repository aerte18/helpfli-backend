const router = require('express').Router();
const Rating = require('../models/Rating');

router.get('/:userId', async (req, res) => {
  try {
    const list = await Rating.find({ to: req.params.userId }).sort({ createdAt: -1 });
    const avg = list.length ? (list.reduce((s,r)=>s+r.rating,0)/list.length) : 0;
    res.json({ avg, count: list.length, list });
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania ocen' });
  }
});

module.exports = router;

