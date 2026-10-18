const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const SponsorAd = require('../models/SponsorAd');
const { recordClick } = require('../utils/sponsorAds');
const { metricsLimiter, sponsorMetricsGuard } = require('../middleware/sponsorMetrics');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  safeUploadName,
  removeUploadedFiles,
  validateUploadedFiles,
} = require('../utils/uploadSafety');

const PUBLIC_AD_SELECT = [
  '_id',
  'adType',
  'title',
  'description',
  'keywords',
  'serviceCategories',
  'orderTypes',
  'locations.city',
  'locations.voivodeship',
  'link',
  'ctaText',
  'imageUrl',
  'logoUrl',
  'videoUrl',
  'mediaType',
  'details',
  'displayLocations',
  'advertiser.companyName',
  'advertiser.website',
  'campaign.startDate',
  'campaign.endDate',
  'status',
  'createdAt',
  'updatedAt',
].join(' ');

function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return authMiddleware(req, res, next);
}

function isAdOwnerOrAdmin(ad, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ad.owner) return String(ad.owner) === String(user._id);
  return ad.advertiser?.email === user.email;
}

function toPublicAd(ad) {
  const value = ad?.toObject ? ad.toObject() : ad;
  if (!value) return value;
  return {
    _id: value._id,
    id: value._id,
    adType: value.adType,
    title: value.title,
    description: value.description,
    keywords: value.keywords,
    serviceCategories: value.serviceCategories,
    orderTypes: value.orderTypes,
    locations: value.locations,
    link: value.link,
    ctaText: value.ctaText,
    imageUrl: value.imageUrl,
    logoUrl: value.logoUrl,
    videoUrl: value.videoUrl,
    mediaType: value.mediaType,
    details: value.details,
    displayLocations: value.displayLocations,
    advertiser: value.advertiser ? {
      companyName: value.advertiser.companyName,
      website: value.advertiser.website,
    } : undefined,
    campaign: value.campaign ? {
      startDate: value.campaign.startDate,
      endDate: value.campaign.endDate,
    } : undefined,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    abTestVariant: value.abTestVariant,
    abTestData: value.abTestData ? {
      title: value.abTestData.title,
      description: value.abTestData.description,
      imageUrl: value.abTestData.imageUrl,
      ctaText: value.abTestData.ctaText,
    } : undefined,
  };
}

function normalizeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseJsonValue(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error(`Nieprawidłowy format pola ${label}`);
    error.statusCode = 400;
    throw error;
  }
}

function mediaTypeForFile(file) {
  if (!file) return 'image';
  if (file.mimetype === 'image/gif') return 'gif';
  if (String(file.mimetype || '').startsWith('video/')) return 'video';
  return 'image';
}

// Konfiguracja multer dla uploadu obrazów
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'sponsor-ads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    try {
      cb(null, safeUploadName('sponsor-ad', file, req.user?._id));
    } catch (error) {
      cb(error);
    }
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB (dla GIF i wideo)
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/ogg',
    ]);
    if (allowed.has(String(file.mimetype || '').toLowerCase())) return cb(null, true);
    return cb(new Error('Dozwolone formaty: obrazy (JPG, PNG, GIF, WebP) i wideo (MP4, WebM, OGG)'));
  }
});

function runAdUpload(req, res, next) {
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'logo', maxCount: 1 }])(req, res, async (error) => {
    if (error) {
      removeUploadedFiles(req.files);
      return res.status(400).json({ message: error.message || 'Błąd uploadu reklamy' });
    }
    try {
      if (!(await validateUploadedFiles(req.files))) {
        removeUploadedFiles(req.files);
        return res.status(400).json({ message: 'Zawartość pliku nie odpowiada zadeklarowanemu formatowi' });
      }
      return next();
    } catch (validationError) {
      removeUploadedFiles(req.files);
      return res.status(400).json({ message: 'Nie udało się zweryfikować pliku' });
    }
  });
}

// Middleware - tylko admin dla niektórych endpointów
const requireAdmin = async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Dostęp tylko dla administratorów' });
  }
  next();
};

// POST /api/sponsor-ads - Utwórz nową reklamę (wymaga konta)
router.post('/', authMiddleware, runAdUpload, async (req, res) => {
  try {
    const {
      advertiser,
      adType,
      title,
      description,
      keywords,
      serviceCategories,
      orderTypes,
      locations,
      link,
      ctaText,
      campaign,
      details
    } = req.body;

    // Parsuj JSON jeśli przysłano jako string
    const advertiserData = typeof advertiser === 'string' ? JSON.parse(advertiser) : advertiser;
    const campaignData = typeof campaign === 'string' ? JSON.parse(campaign) : campaign;
    const detailsData = typeof details === 'string' ? JSON.parse(details) : details;
    const displayLocationsData = typeof req.body.displayLocations === 'string' ? JSON.parse(req.body.displayLocations) : (req.body.displayLocations || []);
    const geotargetingData = typeof req.body.geotargeting === 'string' ? JSON.parse(req.body.geotargeting) : (req.body.geotargeting || { enabled: false });
    if (!advertiserData?.companyName || !campaignData || !title || !description) {
      removeUploadedFiles(req.files);
      return res.status(400).json({ message: 'Brak wymaganych danych reklamy' });
    }
    const normalizedLink = normalizeHttpUrl(link);
    if (!normalizedLink) {
      removeUploadedFiles(req.files);
      return res.status(400).json({ message: 'Link reklamy musi używać protokołu HTTP lub HTTPS' });
    }
    advertiserData.email = req.user.email;
    let packageType = req.body.package || 'custom';
    let priority = req.user.role === 'admin'
      ? Math.max(0, Math.min(100, parseInt(req.body.priority, 10) || 0))
      : 0;
    
    // Affiliate system - sprawdź kod referencyjny
    const referralCode = req.body.referralCode;
    let referredBy = null;
    if (referralCode) {
      // Znajdź firmę, która ma ten kod referencyjny
      const referringAd = await SponsorAd.findOne({
        'advertiser.referralCode': referralCode,
        status: { $in: ['active', 'expired'] } // Tylko aktywne lub zakończone kampanie
      });
      if (referringAd) {
        referredBy = referringAd.advertiser.email;
        // Przyznaj prowizję firmie polecającej (10% z ceny kampanii)
        const commission = Math.round((campaignData.budget || 0) * 0.10);
        referringAd.advertiser.affiliateEarnings = (referringAd.advertiser.affiliateEarnings || 0) + commission;
        await referringAd.save();
      }
    }
    
    // Generuj unikalny kod referencyjny dla nowej firmy
    const newReferralCode = `REF-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    
    advertiserData.referredBy = referredBy;
    advertiserData.referralCode = newReferralCode;
    
    // Sprawdź czy firma może skorzystać z darmowej próby
    const isFreeTrialRequested = req.body.isFreeTrial === 'true' || req.body.isFreeTrial === true;
    let isFreeTrial = false;
    let freeTrialData = null;
    
    if (isFreeTrialRequested) {
      // Sprawdź czy firma już korzystała z darmowej próby
      const ownerFilter = {
        $or: [
          { owner: req.user._id },
          { owner: { $exists: false }, 'advertiser.email': req.user.email },
        ],
      };
      const existingTrial = await SponsorAd.findOne({
        ...ownerFilter,
        'freeTrial.isFreeTrial': true,
        'freeTrial.convertedToPackage': false
      });
      
      if (!existingTrial) {
        // Sprawdź czy firma już miała jakąkolwiek darmową próbę (nawet jeśli skonwertowała)
        const hadTrial = await SponsorAd.findOne({
          ...ownerFilter,
          'freeTrial.isFreeTrial': true
        });
        
        if (!hadTrial) {
          // Może skorzystać z darmowej próby
          isFreeTrial = true;
          const now = new Date();
          const trialEndDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 dni
          
          freeTrialData = {
            isFreeTrial: true,
            trialStartDate: now,
            trialEndDate: trialEndDate,
            trialImpressionsLimit: 100,
            trialImpressionsUsed: 0,
            convertedToPackage: false,
            conversionOfferSent: false
          };
          
          // Ustaw parametry darmowej próby
          packageType = 'free_trial';
          priority = 1; // Niski priorytet dla darmowych prób
        }
      }
    }

    const ad = await SponsorAd.create({
      owner: req.user._id,
      advertiser: advertiserData,
      adType,
      title,
      description,
      keywords: Array.isArray(keywords) ? keywords : (keywords ? keywords.split(',') : []),
      serviceCategories: Array.isArray(serviceCategories) ? serviceCategories : (serviceCategories ? serviceCategories.split(',') : []),
      orderTypes: Array.isArray(orderTypes) ? orderTypes : (orderTypes ? orderTypes.split(',') : []),
      locations: Array.isArray(locations) ? locations : (locations ? JSON.parse(locations) : []),
      link: normalizedLink,
      ctaText: ctaText || 'Sprawdź ofertę',
      package: isFreeTrial ? 'free_trial' : packageType,
      displayLocations: isFreeTrial ? ['landing_page_banner'] : displayLocationsData, // Tylko banner dla próby
      priority: isFreeTrial ? 1 : priority,
      freeTrial: freeTrialData || {
        isFreeTrial: false,
        trialImpressionsUsed: 0
      },
      campaign: {
        budget: isFreeTrial ? 0 : Math.max(0, Number(campaignData.budget) || 0),
        spent: 0,
        pricingModel: isFreeTrial ? 'package' : campaignData.pricingModel,
        startDate: campaignData.startDate,
        endDate: campaignData.endDate,
        dailyBudget: Math.max(0, Number(campaignData.dailyBudget) || 0) || undefined,
        maxImpressions: Math.max(0, Number(campaignData.maxImpressions) || 0) || undefined,
        maxClicks: Math.max(0, Number(campaignData.maxClicks) || 0) || undefined,
        autoRenew: campaignData.autoRenew === true || campaignData.autoRenew === 'true',
        renewalPeriod: Math.max(1, Math.min(365, parseInt(campaignData.renewalPeriod, 10) || 30)),
        subscriptionMonths: [1, 3, 6, 12].includes(Number(campaignData.subscriptionMonths))
          ? Number(campaignData.subscriptionMonths)
          : 1,
        originalPrice: isFreeTrial ? 0 : Math.max(0, Number(campaignData.budget) || 0),
        discountApplied: 0,
      },
      details: detailsData || {},
      geotargeting: geotargetingData,
      mediaType: mediaTypeForFile(req.files?.image?.[0]),
      imageUrl: req.files?.image?.[0] && !String(req.files.image[0].mimetype).startsWith('video/') ? `/uploads/sponsor-ads/${req.files.image[0].filename}` : undefined,
      videoUrl: req.files?.image?.[0] && String(req.files.image[0].mimetype).startsWith('video/') ? `/uploads/sponsor-ads/${req.files.image[0].filename}` : undefined,
      logoUrl: req.files?.logo?.[0] ? `/uploads/sponsor-ads/${req.files.logo[0].filename}` : undefined,
      // Każda kreacja musi przejść moderację, także bezpłatna próba.
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      ad,
      message: isFreeTrial 
        ? 'Darmowa próba została zapisana i oczekuje na akceptację administratora.'
        : 'Reklama została utworzona i oczekuje na akceptację administratora',
      isFreeTrial: isFreeTrial
    });
  } catch (error) {
    removeUploadedFiles(req.files);
    console.error('Error creating sponsor ad:', error);
    res.status(500).json({ message: 'Błąd tworzenia reklamy', error: error.message });
  }
});

// GET /api/sponsor-ads - Lista reklam (admin widzi wszystkie, firmy tylko swoje, publiczne dla frontendu)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { status, adType, limit = 50, context, displayLocation } = req.query;
    const query = {};

    // Jeśli jest kontekst lub displayLocation, użyj findRelevantAds (dla frontendu)
    // displayLocation wymaga użycia findRelevantAds dla prawidłowego filtrowania
    if (context || displayLocation) {
      try {
        const contextData = context ? JSON.parse(context) : {};
        const { findRelevantAds } = require('../utils/sponsorAds');
        const userId = req.user?._id || null; // Przekaż userId dla retargetingu
        const relevantAds = await findRelevantAds(contextData, parseInt(limit) || 3, displayLocation, userId);
        return res.json({ ads: (relevantAds || []).map(toPublicAd) });
      } catch (error) {
        console.error('[GET /api/sponsor-ads] Error parsing context or finding relevant ads:', error);
        console.error('[GET /api/sponsor-ads] Stack:', error.stack);
        // Fall through to regular query if there's an error
      }
    }

    // Dla admina i firm - zwykłe zapytanie
    if (req.user) {
      // Admin widzi wszystkie, firmy tylko swoje (po emailu)
      if (req.user.role !== 'admin') {
        query.$or = [
          { owner: req.user._id },
          { owner: { $exists: false }, 'advertiser.email': req.user.email },
        ];
      }
    } else {
      // Publiczne - tylko aktywne reklamy
      query.status = 'active';
    }

    if (req.user && status) query.status = status;
    if (adType) query.adType = adType;
    
    // Filtruj po displayLocation jeśli podano
    if (displayLocation) {
      query.displayLocations = { $in: [displayLocation] };
    }

    const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    let adsQuery = SponsorAd.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .limit(safeLimit);
    if (!req.user) adsQuery = adsQuery.select(PUBLIC_AD_SELECT);
    const ads = await adsQuery.lean();

    res.json({ ads: req.user ? ads : ads.map(toPublicAd) });
  } catch (error) {
    console.error('Error fetching sponsor ads:', error);
    res.status(500).json({ message: 'Błąd pobierania reklam', error: error.message });
  }
});

// SPECYFICZNE ROUTY PRZED /:id (ważna kolejność!)
// GET /api/sponsor-ads/auction/:location - Pobierz informacje o aukcji
router.get('/auction/:location', async (req, res) => {
  try {
    const { location } = req.params;
    
    const activeAuction = await SponsorAd.findOne({
      'auction.enabled': true,
      'auction.displayLocation': location,
      'auction.auctionEndDate': { $gt: new Date() },
      status: 'active'
    }).sort({ 'auction.currentBid': -1 });

    if (!activeAuction) {
      return res.status(404).json({ message: 'Brak aktywnej aukcji dla tej pozycji' });
    }

    res.json({
      success: true,
      auction: {
        displayLocation: activeAuction.auction.displayLocation,
        currentBid: activeAuction.auction.currentBid,
        minBid: activeAuction.auction.currentBid + activeAuction.auction.bidIncrement,
        bidIncrement: activeAuction.auction.bidIncrement,
        auctionEndDate: activeAuction.auction.auctionEndDate,
        biddersCount: activeAuction.auction.bidders.length,
        topBidders: activeAuction.auction.bidders
          .sort((a, b) => b.bidAmount - a.bidAmount)
          .slice(0, 5) // Top 5 ofert
      }
    });
  } catch (error) {
    console.error('Error fetching auction:', error);
    res.status(500).json({ message: 'Błąd pobierania aukcji', error: error.message });
  }
});

// GET /api/sponsor-ads/:id - Szczegóły reklamy
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id).lean();
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (!isAdOwnerOrAdmin(ad, req.user)) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    res.json({ ad });
  } catch (error) {
    console.error('Error fetching sponsor ad:', error);
    res.status(500).json({ message: 'Błąd pobierania reklamy', error: error.message });
  }
});

// DELETE /api/sponsor-ads/:id - Usuń reklamę
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (!isAdOwnerOrAdmin(ad, req.user)) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    // Usuń tylko jeśli status to pending
    if (ad.status !== 'pending') {
      return res.status(400).json({ 
        message: 'Można usunąć tylko reklamy oczekujące na akceptację' 
      });
    }

    await SponsorAd.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting ad:', error);
    res.status(500).json({ message: 'Błąd usuwania reklamy', error: error.message });
  }
});

// PUT /api/sponsor-ads/:id - Aktualizuj reklamę
router.put('/:id', authMiddleware, runAdUpload, async (req, res) => {
  let persisted = false;
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (!isAdOwnerOrAdmin(ad, req.user)) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const updates = {};
    const contentFields = [
      'title', 'description', 'keywords', 'serviceCategories', 'orderTypes',
      'locations', 'link', 'ctaText', 'details', 'geotargeting', 'displayLocations',
    ];
    for (const field of contentFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    for (const field of ['keywords', 'serviceCategories', 'orderTypes']) {
      if (typeof updates[field] === 'string') {
        updates[field] = updates[field].split(',').map((item) => item.trim()).filter(Boolean);
      }
    }
    for (const field of ['locations', 'details', 'geotargeting', 'displayLocations']) {
      if (updates[field] !== undefined) updates[field] = parseJsonValue(updates[field], field);
    }
    if (updates.link !== undefined) {
      updates.link = normalizeHttpUrl(updates.link);
      if (!updates.link) {
        removeUploadedFiles(req.files);
        return res.status(400).json({ message: 'Link reklamy musi używać protokołu HTTP lub HTTPS' });
      }
    }

    const campaignInput = parseJsonValue(req.body.campaign, 'campaign');
    if (campaignInput && typeof campaignInput === 'object') {
      const allowedCampaignFields = [
        'startDate', 'endDate', 'dailyBudget', 'maxImpressions', 'maxClicks',
        'autoRenew', 'renewalPeriod',
      ];
      if (req.user.role === 'admin') {
        allowedCampaignFields.push('budget', 'pricingModel', 'subscriptionMonths');
      }
      const campaignUpdates = {};
      for (const field of allowedCampaignFields) {
        if (campaignInput[field] !== undefined) campaignUpdates[field] = campaignInput[field];
      }
      if (campaignUpdates.autoRenew !== undefined) {
        campaignUpdates.autoRenew = campaignUpdates.autoRenew === true || campaignUpdates.autoRenew === 'true';
      }
      if (campaignUpdates.renewalPeriod !== undefined) {
        campaignUpdates.renewalPeriod = Math.max(1, Math.min(365, parseInt(campaignUpdates.renewalPeriod, 10) || 30));
      }
      updates.campaign = {
        ...(ad.campaign?.toObject ? ad.campaign.toObject() : ad.campaign || {}),
        ...campaignUpdates,
      };
    }

    // Aktualizuj obrazy/wideo jeśli przesłano
    if (req.files?.image?.[0]) {
      const mediaType = mediaTypeForFile(req.files.image[0]);
      if (mediaType === 'video') {
        updates.videoUrl = `/uploads/sponsor-ads/${req.files.image[0].filename}`;
        updates.imageUrl = undefined; // Usuń stary obraz jeśli był
      } else {
        updates.imageUrl = `/uploads/sponsor-ads/${req.files.image[0].filename}`;
        updates.videoUrl = undefined; // Usuń stare wideo jeśli było
      }
      updates.mediaType = mediaType;
    }
    if (req.files?.logo?.[0]) {
      updates.logoUrl = `/uploads/sponsor-ads/${req.files.logo[0].filename}`;
    }

    if (req.user.role === 'admin') {
      const allowedStatuses = new Set(['pending', 'active', 'paused', 'expired', 'rejected']);
      if (req.body.status !== undefined) {
        if (!allowedStatuses.has(req.body.status)) {
          removeUploadedFiles(req.files);
          return res.status(400).json({ message: 'Nieprawidłowy status reklamy' });
        }
        updates.status = req.body.status;
      }
      if (req.body.priority !== undefined) {
        updates.priority = Math.max(0, Math.min(100, parseInt(req.body.priority, 10) || 0));
      }
    }

    if (req.user.role === 'admin' && updates.status && updates.status !== ad.status) {
      updates.moderation = {
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        notes: req.body.moderationNotes || ad.moderation?.notes
      };
    } else if (req.user.role !== 'admin' && ad.status === 'active' && Object.keys(updates).length > 0) {
      // Zmiana treści po akceptacji zawsze wraca do moderacji.
      updates.status = 'pending';
      updates.moderation = undefined;
    }

    Object.assign(ad, updates);
    await ad.save();
    persisted = true;

    res.json({ success: true, ad });
  } catch (error) {
    if (!persisted) removeUploadedFiles(req.files);
    console.error('Error updating sponsor ad:', error);
    res.status(error.statusCode || 500).json({
      message: error.statusCode === 400 ? error.message : 'Błąd aktualizacji reklamy',
    });
  }
});

// POST /api/sponsor-ads/:id/impression - Zarejestruj wyświetlenie reklamy
router.post('/:id/impression', metricsLimiter, sponsorMetricsGuard, async (req, res) => {
  try {
    const { recordImpression } = require('../utils/sponsorAds');
    const { page, position, context } = req.body;
    const userId = req.user?._id || null;
    
    // Przygotuj kontekst dla recordImpression
    const impressionContext = {
      page: page || null,
      position: position || null,
      ...(context || {})
    };
    
    await recordImpression(req.params.id, userId, impressionContext);
    res.json({ success: true });
  } catch (error) {
    console.error('Error recording impression:', error);
    // Nie zwracaj błędu - impression tracking nie powinien psuć strony
    res.status(200).json({ success: false, message: 'Błąd rejestracji wyświetlenia (ignorowany)' });
  }
});

// POST /api/sponsor-ads/:id/click - Zarejestruj kliknięcie w reklamę
router.post('/:id/click', metricsLimiter, sponsorMetricsGuard, async (req, res) => {
  try {
    const { context } = req.body;
    const userId = req.user?._id || null;
    await recordClick(req.params.id, userId, context);
    res.json({ success: true });
  } catch (error) {
    console.error('Error recording click:', error);
    res.status(500).json({ message: 'Błąd rejestracji kliknięcia', error: error.message });
  }
});

// POST /api/sponsor-ads/:id/ab-test - Utwórz/aktualizuj A/B test
router.post('/:id/ab-test', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    // Sprawdź czy pakiet Enterprise (A/B testing tylko dla Enterprise)
    if (ad.package !== 'enterprise') {
      return res.status(400).json({ 
        message: 'A/B Testing dostępne tylko dla pakietu Enterprise' 
      });
    }

    const { variants, minImpressions, autoSelectWinner } = req.body;

    if (!variants || !Array.isArray(variants) || variants.length < 2) {
      return res.status(400).json({ 
        message: 'Musisz podać co najmniej 2 warianty (A, B, C)' 
      });
    }

    // Walidacja wariantów
    const validVariants = ['A', 'B', 'C'];
    for (const variant of variants) {
      if (!validVariants.includes(variant.variant)) {
        return res.status(400).json({ 
          message: `Nieprawidłowy wariant: ${variant.variant}. Dozwolone: A, B, C` 
        });
      }
    }

    // Aktualizuj A/B test
    ad.abTest = {
      isActive: true,
      variants: variants.map(v => ({
        variant: v.variant,
        title: v.title || ad.title,
        description: v.description || ad.description,
        imageUrl: v.imageUrl || ad.imageUrl,
        ctaText: v.ctaText || ad.ctaText,
        stats: {
          impressions: 0,
          clicks: 0,
          conversions: 0,
          ctr: 0,
          conversionRate: 0
        }
      })),
      currentVariant: variants[0].variant, // Domyślnie pierwszy wariant
      testStartDate: new Date(),
      testEndDate: req.body.testEndDate ? new Date(req.body.testEndDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 dni domyślnie
      minImpressions: minImpressions || 1000,
      winner: null,
      autoSelectWinner: autoSelectWinner !== undefined ? autoSelectWinner : true
    };

    await ad.save();

    res.json({ 
      success: true, 
      abTest: ad.abTest,
      message: 'A/B test został utworzony. System automatycznie wybierze najlepszy wariant po osiągnięciu minimalnej liczby wyświetleń.'
    });
  } catch (error) {
    console.error('Error creating AB test:', error);
    res.status(500).json({ message: 'Błąd tworzenia A/B testu', error: error.message });
  }
});

// GET /api/sponsor-ads/:id/ab-test - Pobierz statystyki A/B testu
router.get('/:id/ab-test', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    if (!ad.abTest || !ad.abTest.isActive) {
      return res.status(404).json({ message: 'A/B test nie jest aktywny' });
    }

    res.json({ 
      success: true, 
      abTest: ad.abTest 
    });
  } catch (error) {
    console.error('Error fetching AB test:', error);
    res.status(500).json({ message: 'Błąd pobierania A/B testu', error: error.message });
  }
});

// POST /api/sponsor-ads/:id/ab-test/stop - Zatrzymaj A/B test i wybierz zwycięzcę ręcznie
router.post('/:id/ab-test/stop', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    if (!ad.abTest || !ad.abTest.isActive) {
      return res.status(400).json({ message: 'A/B test nie jest aktywny' });
    }

    const { winner } = req.body;
    if (!winner || !['A', 'B', 'C'].includes(winner)) {
      return res.status(400).json({ message: 'Musisz podać zwycięzcę: A, B lub C' });
    }

    // Zatrzymaj test i ustaw zwycięzcę
    ad.abTest.isActive = false;
    ad.abTest.winner = winner;
    ad.abTest.currentVariant = winner;
    ad.abTest.testEndDate = new Date();

    await ad.save();

    res.json({ 
      success: true, 
      abTest: ad.abTest,
      message: `A/B test został zatrzymany. Zwycięzca: wariant ${winner}`
    });
  } catch (error) {
    console.error('Error stopping AB test:', error);
    res.status(500).json({ message: 'Błąd zatrzymywania A/B testu', error: error.message });
  }
});

// GET /api/sponsor-ads/:id/stats - Statystyki reklamy
router.get('/:id/stats', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id).lean();
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const SponsorImpression = require('../models/SponsorImpression');
    const impressions = await SponsorImpression.find({ ad: req.params.id }).sort({ createdAt: -1 }).lean();
    
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Filtruj ostatnie 30 dni
    const recentImpressions = impressions.filter(imp => new Date(imp.createdAt) >= thirtyDaysAgo);
    
    const stats = {
      totalImpressions: ad.stats.impressions,
      totalClicks: ad.stats.clicks,
      totalConversions: ad.stats.conversions,
      ctr: ad.stats.ctr,
      conversionRate: ad.stats.conversionRate || 0,
      budgetSpent: ad.campaign.spent,
      budgetRemaining: ad.campaign.budget - ad.campaign.spent,
      budgetTotal: ad.campaign.budget,
      impressionsByDay: {},
      clicksByDay: {},
      conversionsByDay: {},
      // Statystyki z ostatnich 7 dni
      last7Days: {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: 0,
        conversionRate: 0
      },
      // Statystyki z ostatnich 30 dni
      last30Days: {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: 0,
        conversionRate: 0
      },
      // Porównanie z poprzednim okresem
      comparison: {
        impressionsChange: 0,
        clicksChange: 0,
        ctrChange: 0
      }
    };

    // Grupuj po dniach
    recentImpressions.forEach(imp => {
      const date = new Date(imp.createdAt).toISOString().split('T')[0];
      const impDate = new Date(imp.createdAt);
      
      if (imp.type === 'impression') {
        stats.impressionsByDay[date] = (stats.impressionsByDay[date] || 0) + 1;
        if (impDate >= sevenDaysAgo) stats.last7Days.impressions++;
        stats.last30Days.impressions++;
      } else if (imp.type === 'click') {
        stats.clicksByDay[date] = (stats.clicksByDay[date] || 0) + 1;
        if (impDate >= sevenDaysAgo) stats.last7Days.clicks++;
        stats.last30Days.clicks++;
      } else if (imp.type === 'conversion') {
        stats.conversionsByDay[date] = (stats.conversionsByDay[date] || 0) + 1;
        if (impDate >= sevenDaysAgo) stats.last7Days.conversions++;
        stats.last30Days.conversions++;
      }
    });

    // Oblicz CTR i conversion rate dla okresów
    if (stats.last7Days.impressions > 0) {
      stats.last7Days.ctr = (stats.last7Days.clicks / stats.last7Days.impressions) * 100;
      stats.last7Days.conversionRate = (stats.last7Days.conversions / stats.last7Days.clicks) * 100;
    }
    if (stats.last30Days.impressions > 0) {
      stats.last30Days.ctr = (stats.last30Days.clicks / stats.last30Days.impressions) * 100;
      stats.last30Days.conversionRate = (stats.last30Days.conversions / stats.last30Days.clicks) * 100;
    }

    // Porównanie z poprzednim okresem (ostatnie 7 dni vs poprzednie 7 dni)
    const previous7DaysStart = new Date(sevenDaysAgo.getTime() - 7 * 24 * 60 * 60 * 1000);
    const previous7Days = impressions.filter(imp => {
      const impDate = new Date(imp.createdAt);
      return impDate >= previous7DaysStart && impDate < sevenDaysAgo;
    });
    
    const prev7DaysImpressions = previous7Days.filter(imp => imp.type === 'impression').length;
    const prev7DaysClicks = previous7Days.filter(imp => imp.type === 'click').length;
    const prev7DaysCTR = prev7DaysImpressions > 0 ? (prev7DaysClicks / prev7DaysImpressions) * 100 : 0;
    
    if (prev7DaysImpressions > 0) {
      stats.comparison.impressionsChange = ((stats.last7Days.impressions - prev7DaysImpressions) / prev7DaysImpressions) * 100;
      stats.comparison.clicksChange = ((stats.last7Days.clicks - prev7DaysClicks) / prev7DaysClicks) * 100;
      stats.comparison.ctrChange = stats.last7Days.ctr - prev7DaysCTR;
    }

    res.json({ stats });
  } catch (error) {
    console.error('Error fetching ad stats:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk', error: error.message });
  }
});

// POST /api/sponsor-ads/:id/approve - Zatwierdź reklamę (admin)
router.post('/:id/approve', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    ad.status = 'active';
    ad.moderation = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      notes: req.body.notes || 'Zatwierdzona przez administratora'
    };
    await ad.save();

    res.json({ success: true, ad });
  } catch (error) {
    console.error('Error approving ad:', error);
    res.status(500).json({ message: 'Błąd zatwierdzania reklamy', error: error.message });
  }
});

// POST /api/sponsor-ads/:id/reject - Odrzuć reklamę (admin)
router.post('/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    ad.status = 'rejected';
    ad.moderation = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      rejectionReason: req.body.reason || 'Odrzucona przez administratora',
      notes: req.body.notes
    };
    await ad.save();

    res.json({ success: true, ad });
  } catch (error) {
    console.error('Error rejecting ad:', error);
    res.status(500).json({ message: 'Błąd odrzucania reklamy', error: error.message });
  }
});

// GET /api/sponsor-ads/:id/report/pdf - Generuj raport PDF dla reklamy
router.get('/:id/report/pdf', authMiddleware, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    // Pobierz statystyki
    const impressions = await SponsorImpression.find({ ad: ad._id })
      .sort({ createdAt: -1 })
      .lean();

    // Grupuj po dniach
    const statsByDay = {};
    impressions.forEach(imp => {
      const date = new Date(imp.createdAt).toISOString().split('T')[0];
      if (!statsByDay[date]) {
        statsByDay[date] = { impressions: 0, clicks: 0, conversions: 0 };
      }
      if (imp.type === 'impression') statsByDay[date].impressions++;
      if (imp.type === 'click') statsByDay[date].clicks++;
      if (imp.type === 'conversion') statsByDay[date].conversions++;
    });

    // Generuj PDF
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=raport-reklamy-${ad.title.replace(/[^a-z0-9]/gi, '_')}-${new Date().toISOString().split('T')[0]}.pdf`
    );

    doc.pipe(res);

    // Nagłówek
    doc
      .fontSize(24)
      .text('Raport Reklamy Sponsorowanej', { align: 'center' })
      .moveDown(0.5)
      .fontSize(14)
      .text(`Kampania: ${ad.title}`, { align: 'center' })
      .text(`Firma: ${ad.advertiser.companyName}`, { align: 'center' })
      .text(`Okres: ${new Date(ad.campaign.startDate).toLocaleDateString('pl-PL')} - ${new Date(ad.campaign.endDate).toLocaleDateString('pl-PL')}`, { align: 'center' })
      .text(`Wygenerowano: ${new Date().toLocaleDateString('pl-PL')}`, { align: 'center' })
      .moveDown(1);

    // Statystyki ogólne
    doc
      .fontSize(18)
      .text('Statystyki ogólne', { underline: true })
      .moveDown(0.5)
      .fontSize(12);

    const totalImpressions = ad.stats.impressions || 0;
    const totalClicks = ad.stats.clicks || 0;
    const totalConversions = ad.stats.conversions || 0;
    const ctr = ad.stats.ctr || 0;
    const conversionRate = ad.stats.conversionRate || 0;
    const budgetSpent = ad.campaign.spent || 0;
    const budgetTotal = ad.campaign.budget || 0;
    const budgetRemaining = budgetTotal - budgetSpent;

    doc
      .text(`Wyświetlenia: ${totalImpressions.toLocaleString()}`, { indent: 20 })
      .text(`Kliknięcia: ${totalClicks.toLocaleString()}`, { indent: 20 })
      .text(`Konwersje: ${totalConversions.toLocaleString()}`, { indent: 20 })
      .text(`CTR: ${ctr.toFixed(2)}%`, { indent: 20 })
      .text(`Conversion Rate: ${conversionRate.toFixed(2)}%`, { indent: 20 })
      .moveDown(0.5)
      .text(`Budżet: ${(budgetTotal / 100).toFixed(2)} zł`, { indent: 20 })
      .text(`Wydane: ${(budgetSpent / 100).toFixed(2)} zł`, { indent: 20 })
      .text(`Pozostało: ${(budgetRemaining / 100).toFixed(2)} zł`, { indent: 20 })
      .moveDown(1);

    // Statystyki dzienne
    doc
      .fontSize(18)
      .text('Statystyki dzienne', { underline: true })
      .moveDown(0.5)
      .fontSize(10);

    const sortedDays = Object.keys(statsByDay).sort();
    sortedDays.slice(0, 30).forEach(date => {
      const stats = statsByDay[date];
      doc
        .text(`${date}:`, { indent: 20, continued: true })
        .text(` Wyświetlenia: ${stats.impressions}, Kliknięcia: ${stats.clicks}, Konwersje: ${stats.conversions}`);
    });

    // Rekomendacje
    doc
      .addPage()
      .fontSize(18)
      .text('Rekomendacje', { underline: true })
      .moveDown(0.5)
      .fontSize(12);

    const recommendations = [];
    if (ctr < 2) {
      recommendations.push('• Niski CTR - rozważ zmianę tytułu lub obrazu reklamy');
    }
    if (conversionRate < 1 && totalClicks > 100) {
      recommendations.push('• Niski conversion rate - sprawdź landing page i CTA');
    }
    if (budgetSpent / budgetTotal > 0.9) {
      recommendations.push('• Budżet prawie wyczerpany - rozważ zwiększenie budżetu');
    }
    if (totalImpressions < 1000 && new Date() > new Date(ad.campaign.endDate.getTime() - 7 * 24 * 60 * 60 * 1000)) {
      recommendations.push('• Mało wyświetleń - rozważ zwiększenie budżetu lub rozszerzenie targetowania');
    }

    if (recommendations.length > 0) {
      recommendations.forEach(rec => doc.text(rec, { indent: 20 }));
    } else {
      doc.text('Kampania działa dobrze! Brak rekomendacji.', { indent: 20 });
    }

    doc.end();
  } catch (error) {
    console.error('Error generating PDF report:', error);
    res.status(500).json({ message: 'Błąd generowania raportu PDF', error: error.message });
  }
});

// POST /api/sponsor-ads/auction/:location/bid - Złóż ofertę w aukcji (przed /:id)
router.post('/auction/:location/bid', authMiddleware, async (req, res) => {
  try {
    const { location } = req.params; // np. 'landing_page_banner'
    const { bidAmount } = req.body; // W groszach
    
    if (!bidAmount || bidAmount <= 0) {
      return res.status(400).json({ message: 'Nieprawidłowa kwota oferty' });
    }

    // Znajdź aktywną aukcję dla tej pozycji
    const activeAuction = await SponsorAd.findOne({
      'auction.enabled': true,
      'auction.displayLocation': location,
      'auction.auctionEndDate': { $gt: new Date() },
      status: 'active'
    }).sort({ 'auction.currentBid': -1 });

    if (!activeAuction) {
      return res.status(404).json({ message: 'Brak aktywnej aukcji dla tej pozycji' });
    }

    // Sprawdź czy oferta jest wyższa niż aktualna
    const minBid = activeAuction.auction.currentBid + activeAuction.auction.bidIncrement;
    if (bidAmount < minBid) {
      return res.status(400).json({ 
        message: `Minimalna oferta: ${(minBid / 100).toFixed(2)} zł (aktualna: ${(activeAuction.auction.currentBid / 100).toFixed(2)} zł + przyrost ${(activeAuction.auction.bidIncrement / 100).toFixed(2)} zł)` 
      });
    }

    // Dodaj ofertę
    activeAuction.auction.bidders.push({
      advertiserEmail: req.user.email || activeAuction.advertiser.email,
      bidAmount: bidAmount,
      bidDate: new Date()
    });
    activeAuction.auction.currentBid = bidAmount;
    await activeAuction.save();

    res.json({ 
      success: true, 
      message: 'Oferta złożona pomyślnie',
      currentBid: bidAmount,
      auction: activeAuction.auction
    });
  } catch (error) {
    console.error('Error placing bid:', error);
    res.status(500).json({ message: 'Błąd składania oferty', error: error.message });
  }
});

// POST /api/sponsor-ads/:id/auction/end - Zakończ aukcję i wybierz zwycięzcę (admin)
router.post('/:id/auction/end', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad || !ad.auction?.enabled) {
      return res.status(404).json({ message: 'Aukcja nie znaleziona' });
    }

    // Znajdź zwycięzcę (najwyższa oferta)
    const topBidder = ad.auction.bidders
      .sort((a, b) => b.bidAmount - a.bidAmount)[0];

    if (!topBidder) {
      return res.status(400).json({ message: 'Brak ofert w aukcji' });
    }

    // Ustaw zwycięzcę
    ad.auction.winner = {
      advertiserEmail: topBidder.advertiserEmail,
      bidAmount: topBidder.bidAmount,
      wonAt: new Date()
    };
    ad.auction.auctionEndDate = new Date();
    ad.campaign.budget = topBidder.bidAmount; // Ustaw budżet na wygraną ofertę
    await ad.save();

    res.json({ 
      success: true, 
      message: 'Aukcja zakończona',
      winner: ad.auction.winner
    });
  } catch (error) {
    console.error('Error ending auction:', error);
    res.status(500).json({ message: 'Błąd kończenia aukcji', error: error.message });
  }
});

module.exports = router;

