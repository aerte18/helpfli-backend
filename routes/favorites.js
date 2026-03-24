const router = require('express').Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const Favorite = require('../models/favorite');

router.get('/', auth, async (req, res) => {
  try {
    const items = await Favorite.find({ user: req.user._id })
      .populate('provider','name email badges rankingPoints ratingAvg');
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania ulubionych' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { providerId } = req.body;
    const fav = await Favorite.create({ user: req.user._id, provider: providerId });
    res.json(fav);
  } catch(e) {
    res.status(400).json({ message: 'Już na liście lub błąd.' });
  }
});

router.delete('/:providerId', auth, async (req, res) => {
  try {
    await Favorite.findOneAndDelete({ user: req.user._id, provider: req.params.providerId });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas usuwania z ulubionych' });
  }
});

module.exports = router;
