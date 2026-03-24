const express = require('express');
const router = express.Router();
const SponsorAd = require('../models/SponsorAd');
const SponsorImpression = require('../models/SponsorImpression');

/**
 * POST /api/sponsor-ads/:id/conversion
 * Zarejestruj konwersję (np. zakup, zapytanie)
 * Może być wywołane przez:
 * 1. Pixel tracking na stronie firmy
 * 2. API webhook z systemu firmy
 * 3. Ręcznie przez firmę w panelu
 */
router.post('/:id/conversion', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      type = 'other', // purchase, inquiry, signup, download, other
      value = 0, // Wartość konwersji w groszach
      currency = 'pln',
      metadata = {} // Dodatkowe dane (np. orderId, productId)
    } = req.body;

    const ad = await SponsorAd.findById(id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź czy reklama jest aktywna
    if (!ad.isActive()) {
      return res.status(400).json({ message: 'Reklama nie jest aktywna' });
    }

    // Zarejestruj konwersję
    const impression = await SponsorImpression.create({
      ad: id,
      user: req.user?._id || null, // Opcjonalnie - użytkownik z sesji
      type: 'conversion',
      date: new Date().toISOString().split('T')[0],
      context: {
        keywords: [],
        serviceCategory: null,
        orderType: null,
        location: null
      },
      conversion: {
        type: type,
        value: value,
        currency: currency,
        metadata: metadata
      }
    });

    // Zaktualizuj statystyki reklamy
    ad.stats.conversions += 1;
    ad.stats.conversionRate = ad.stats.clicks > 0 
      ? (ad.stats.conversions / ad.stats.clicks) * 100 
      : 0;
    await ad.save();

    res.json({
      success: true,
      conversion: impression,
      stats: {
        totalConversions: ad.stats.conversions,
        conversionRate: ad.stats.conversionRate
      }
    });
  } catch (error) {
    console.error('Error recording conversion:', error);
    res.status(500).json({ message: 'Błąd rejestrowania konwersji', error: error.message });
  }
});

/**
 * GET /api/sponsor-ads/:id/conversions
 * Pobierz listę konwersji dla reklamy
 */
router.get('/:id/conversions', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const ad = await SponsorAd.findById(id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia (tylko właściciel reklamy lub admin)
    if (req.user && req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const conversions = await SponsorImpression.find({
      ad: id,
      type: 'conversion'
    })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await SponsorImpression.countDocuments({
      ad: id,
      type: 'conversion'
    });

    res.json({
      conversions,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching conversions:', error);
    res.status(500).json({ message: 'Błąd pobierania konwersji', error: error.message });
  }
});

module.exports = router;






