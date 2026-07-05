const express = require('express');
const router = express.Router();
const SponsorAd = require('../models/SponsorAd');
const SponsorImpression = require('../models/SponsorImpression');
const { authMiddleware } = require('../middleware/authMiddleware');

function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return authMiddleware(req, res, next);
}

function conversionAuthorized(req, ad) {
  const isOwner =
    req.user &&
    (req.user.role === 'admin' || ad.advertiser.email === req.user.email);
  if (isOwner) return true;

  const secret =
    process.env.SPONSOR_CONVERSION_SECRET || process.env.CRON_SECRET;
  const header = req.headers['x-sponsor-conversion-secret'];
  return Boolean(secret && header && header === secret);
}

/**
 * POST /api/sponsor-ads/:id/conversion
 * Pixel / webhook z zewnętrznego systemu wymaga nagłówka X-Sponsor-Conversion-Secret.
 */
router.post('/:id/conversion', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      type = 'other',
      value = 0,
      currency = 'pln',
      metadata = {},
    } = req.body;

    const ad = await SponsorAd.findById(id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    if (!conversionAuthorized(req, ad)) {
      return res.status(401).json({ message: 'Brak autoryzacji konwersji' });
    }

    if (!ad.isActive()) {
      return res.status(400).json({ message: 'Reklama nie jest aktywna' });
    }

    const impression = await SponsorImpression.create({
      ad: id,
      user: req.user?._id || null,
      type: 'conversion',
      date: new Date().toISOString().split('T')[0],
      context: {
        keywords: [],
        serviceCategory: null,
        orderType: null,
        location: null,
      },
      conversion: {
        type,
        value,
        currency,
        metadata,
      },
    });

    ad.stats.conversions += 1;
    ad.stats.conversionRate =
      ad.stats.clicks > 0 ? (ad.stats.conversions / ad.stats.clicks) * 100 : 0;
    await ad.save();

    res.json({
      success: true,
      conversion: impression,
      stats: {
        totalConversions: ad.stats.conversions,
        conversionRate: ad.stats.conversionRate,
      },
    });
  } catch (error) {
    console.error('Error recording conversion:', error);
    res.status(500).json({ message: 'Błąd rejestrowania konwersji', error: error.message });
  }
});

router.get('/:id/conversions', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const ad = await SponsorAd.findById(id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const conversions = await SponsorImpression.find({
      ad: id,
      type: 'conversion',
    })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10))
      .skip(parseInt(offset, 10))
      .lean();

    const total = await SponsorImpression.countDocuments({
      ad: id,
      type: 'conversion',
    });

    res.json({
      conversions,
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });
  } catch (error) {
    console.error('Error fetching conversions:', error);
    res.status(500).json({ message: 'Błąd pobierania konwersji', error: error.message });
  }
});

module.exports = router;
