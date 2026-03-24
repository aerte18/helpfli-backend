const express = require('express');
const router = express.Router();
const { priceHintsFromHistory } = require('../utils/pricing');

// GET /api/ai/pricing/hints?service=hydro_fix_tap&city=Warszawa
router.get('/pricing/hints', async (req, res) => {
  try {
    const { service: serviceCode, city } = req.query;
    if (!serviceCode) return res.status(400).json({ message: 'Brak parametru service' });

    const hints = await priceHintsFromHistory({ serviceCode, cityLike: city || '' });
    res.json({ hints, source: hints ? 'history' : 'none' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Błąd agregacji' });
  }
});

module.exports = router;






















