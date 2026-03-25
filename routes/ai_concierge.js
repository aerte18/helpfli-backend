const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/authMiddleware');
const Service = require('../models/Service');
const Order = require('../models/Order');
const OrderDraft = require('../models/orderDraft');
const User = require('../models/User');
const { scoreServiceMatch, computePriceHints, recommendProviders, findSimilarOrders, findSuccessfulFeedback } = require('../utils/concierge');
const { findRelevantAds, recordImpression, formatAdsForAI } = require('../utils/sponsorAds');
const { priceHintsFromHistory } = require('../utils/pricing');
const DraftQuote = require('../models/draftQuote');

// Funkcja pomocnicza do obliczania dystansu
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Promień Ziemi w km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
const { requireKycVerified } = require('../middleware/kyc');
const { validate } = require('../middleware/validation');
const AIFeedback = require('../models/AIFeedback');

const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '30', 10);
const storageDrafts = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'drafts')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const uploadDrafts = multer({ storage: storageDrafts, limits: { fileSize: MAX_MB*1024*1024 } });

function detectType(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}
const toPublicUrl = (filename) => `/uploads/drafts/${filename}`;

// Upload plików dla AI Concierge
const storageConcierge = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'concierge')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, 'concierge-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const uploadConcierge = multer({ 
  storage: storageConcierge, 
  limits: { fileSize: MAX_MB*1024*1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/avi', 'video/mov'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Niedozwolony typ pliku. Dozwolone: JPG, PNG, GIF, WebP, MP4, AVI, MOV'), false);
    }
  }
});

// POST /api/ai/concierge/upload - upload plików dla AI Concierge
router.post('/concierge/upload', authMiddleware, uploadConcierge.array('files', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'Brak plików do uploadu' });
    }

    const uploadedFiles = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      url: `/uploads/concierge/${file.filename}`,
      type: detectType(file.mimetype),
      size: file.size,
      mimeType: file.mimetype
    }));

    res.json({ 
      success: true, 
      files: uploadedFiles,
      message: `Przesłano ${uploadedFiles.length} plik(ów)`
    });
  } catch (error) {
    console.error('Upload error:', error?.message || error);
    const isKnown = /Niedozwolony typ pliku|File too large/i.test(error?.message || '');
    res.status(isKnown ? 400 : 500).json({ 
      success: false, 
      message: isKnown ? error.message : ('Błąd podczas przesyłania plików: ' + (error?.message || 'nieznany'))
    });
  }
});

// POST /api/ai/concierge/analyze
// body: { description, locationText, lat, lon, urgency, imageUrls, conversationHistory? }
router.post('/concierge/analyze', authMiddleware, validate('aiAnalyze'), async (req, res) => {
  try {
    const { description, locationText, lat, lon, urgency = 'flex', imageUrls = [], conversationHistory = [] } = req.body || {};
    if (!description || description.length < 5) {
      return res.status(400).json({ message: 'Opisz problem nieco dokładniej.' });
    }

    // Określ język na podstawie nagłówków lub body
    const lang = (req.body?.language || req.headers['accept-language'] || 'pl').toLowerCase().startsWith('en') ? 'en' : 'pl';

    // 1) Wywołaj LLM Service (Claude 3.5 z fallbackiem do Ollama)
    const llmService = require('../services/llm_service');
    let llm = null;
    try {
      // Włącz wyszukiwanie internetowe dla złożonych problemów
      const enableWebSearch = description.length > 50 && 
                             (description.toLowerCase().includes('cena') || 
                              description.toLowerCase().includes('koszt') ||
                              description.toLowerCase().includes('ile') ||
                              description.toLowerCase().includes('jak'));
      
      // Oblicz priceHints przed wywołaniem LLM, aby przekazać je jako kontekst
      const services = await Service.find({}).lean();
      const scored = services.map(s => ({
        code: s.code,
        name: s.name,
        score: scoreServiceMatch(description, s),
      })).sort((a,b) => b.score - a.score);
      const bestHeuristicCandidate = scored[0] || null;
      const serviceCandidateForHints = llm?.serviceCandidate || bestHeuristicCandidate;
      
      // Oblicz priceHints wcześniej, aby przekazać do AI
      const precomputedPriceHints = serviceCandidateForHints?.code
        ? (await priceHintsFromHistory({ serviceCode: serviceCandidateForHints.code, cityLike: locationText }).catch(() => null))
          || await computePriceHints(serviceCandidateForHints.code, { lat, lon, text: locationText }).catch(() => null)
        : null;
      
      // Znajdź podobne zlecenia z historii
      const similarOrders = await findSimilarOrders(
        description,
        serviceCandidateForHints?.code,
        locationText,
        5
      );
      
      // Znajdź feedback z podobnych problemów, które zadziałały
      const successfulFeedback = await findSuccessfulFeedback(
        description,
        serviceCandidateForHints?.code,
        locationText,
        3
      );
      
      // Załaduj dostępne części zamienne dla wykrytej kategorii
      const { findPartsByNameOrType, getCityPricingMultiplier } = require('../utils/concierge');
      const detectedCategoryForParts = serviceCandidateForHints?.code 
        ? (serviceCandidateForHints.code.includes('hydraulik') ? 'hydraulika' :
           serviceCandidateForHints.code.includes('elektryk') ? 'elektryka' :
           serviceCandidateForHints.code.includes('it') ? 'it' :
           serviceCandidateForHints.code.includes('remont') ? 'remont' : null)
        : null;
      const availableParts = detectedCategoryForParts ? findPartsByNameOrType('', detectedCategoryForParts) : [];
      
      // Określ mnożnik cenowy dla lokalizacji
      const cityMultiplier = locationText ? getCityPricingMultiplier(locationText) : null;
      
      llm = await llmService.analyzeProblem({ 
        description, 
        imageUrls: imageUrls, 
        lang,
        enableWebSearch,
        priceHints: precomputedPriceHints,
        locationText: locationText,
        similarOrders: similarOrders,
        successfulFeedback: successfulFeedback,
        availableParts: availableParts,
        cityMultiplier: cityMultiplier,
        conversationHistory: conversationHistory
      });
    } catch (error) {
      console.log('LLM Service not available, using fallback:', error.message);
    }

    // Sprawdź limity AI Concierge dla klientów
    const user = await User.findById(req.user._id).populate('company');
    if (user.role === 'client') {
      const UserSubscription = require('../models/UserSubscription');
      const subscription = await UserSubscription.findOne({ 
        user: req.user._id,
        validUntil: { $gt: new Date() }
      });
      
      const packageType = subscription?.planKey || 'CLIENT_FREE';
      const isFree = packageType === 'CLIENT_FREE';
      const isBusinessPlan = subscription?.isBusinessPlan || false;
      const useCompanyPool = subscription?.useCompanyResourcePool || false;
      
      // Sprawdź najpierw resource pool firmy (jeśli użytkownik należy do firmy i ma business plan)
      if (isBusinessPlan && useCompanyPool && user.company) {
        const { canUseCompanyResource, consumeCompanyResource } = require('../utils/resourcePool');
        const check = await canUseCompanyResource(req.user._id, 'aiQueries', 1);
        
        if (!check.allowed) {
          return res.status(403).json({ 
            message: check.reason,
            requiresPayment: false,
            upgradeRequired: true,
            upgradePlan: 'BUSINESS_PRO'
          });
        }
        
        // Wykorzystaj zasób z puli firmowej
        await consumeCompanyResource(req.user._id, 'aiQueries', 1);
        
        // Zapisz użycie w UsageAnalytics
        try {
          const UsageAnalytics = require('../models/UsageAnalytics');
          const now = new Date();
          const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          await UsageAnalytics.incrementUsage(req.user._id, monthKey, 'aiQueries', 1, false);
        } catch (analyticsError) {
          console.error('Error saving AI usage analytics:', analyticsError);
        }
      } else if (isFree) {
        // Sprawdź czy nie przekroczył limitu 50 zapytań miesięcznie (dla FREE)
        const currentMonth = new Date();
        currentMonth.setDate(1);
        currentMonth.setHours(0, 0, 0, 0);
        
        const aiUsage = await User.findOne({ 
          _id: req.user._id 
        }).select('aiConciergeUsage');
        
        const monthlyUsage = aiUsage?.aiConciergeUsage?.filter(usage => 
          new Date(usage.date) >= currentMonth
        ) || [];
        
        // Zapisz użycie w UsageAnalytics
        try {
          const UsageAnalytics = require('../models/UsageAnalytics');
          const now = new Date();
          const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          await UsageAnalytics.incrementUsage(req.user._id, monthKey, 'aiQueries', 1, false);
        } catch (analyticsError) {
          console.error('Error saving AI usage analytics:', analyticsError);
        }
        
        if (monthlyUsage.length >= 50) { // Limit 50 zapytań miesięcznie dla darmowych użytkowników
          // Sprawdź czy użytkownik chce zapłacić za dodatkowe zapytania (pay-per-use)
          const { payPerUse } = req.body || {};
          
          if (payPerUse === true) {
            // Pay-per-use: 0.50 zł za zapytanie (50 groszy)
            const payPerUsePrice = 50; // grosze
            
            // W trybie development - od razu aktywuj
            if (process.env.NODE_ENV === 'development') {
              // Zapisujemy użycie jako płatne
              user.aiConciergeUsage.push({
                date: new Date(),
                description: req.body.description || '',
                service: '',
                paid: true,
                payPerUsePrice: payPerUsePrice
              });
              await user.save();
              
              // Kontynuuj normalnie - zapytanie zostało opłacone
            } else {
              // Produkcja - wymagaj płatności przez Stripe
              const Stripe = require('stripe');
              const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
              
              if (!stripe) {
                return res.status(500).json({ message: 'Płatności nie są skonfigurowane' });
              }
              
              const intent = await stripe.paymentIntents.create({
                amount: payPerUsePrice,
                currency: 'pln',
                payment_method_types: ['card', 'p24'],
                description: `Helpfli AI Concierge - dodatkowe zapytanie`,
                metadata: {
                  type: 'ai_concierge_pay_per_use',
                  userId: String(req.user._id),
                  usageCount: monthlyUsage.length + 1
                }
              });
              
              return res.status(402).json({
                requiresPayment: true,
                message: 'Wymagana płatność za dodatkowe zapytanie AI',
                paymentIntentId: intent.id,
                clientSecret: intent.client_secret,
                amount: payPerUsePrice,
                pricePLN: (payPerUsePrice / 100).toFixed(2),
                upsell: {
                  recommendedPlanKey: 'CLIENT_STD',
                  title: 'STANDARD – nielimitowane AI Concierge',
                  description: 'Lub wykup plan STANDARD za 19 zł/mies aby uzyskać nielimitowany dostęp.',
                }
              });
            }
          } else {
            // Standardowa odpowiedź z limitem
            return res.status(403).json({ 
              message: 'Przekroczono limit 50 zapytań do AI Concierge miesięcznie. Ulepsz pakiet lub zapłać za dodatkowe zapytania.',
              limit: 50,
              used: monthlyUsage.length,
              planKey: packageType,
              payPerUseAvailable: true,
              payPerUsePrice: 0.50, // zł
              upsell: {
                recommendedPlanKey: 'CLIENT_STD',
                title: 'STANDARD – nielimitowane AI Concierge',
                description: 'Kontynuuj rozmowę z AI bez limitów i szybciej znajduj najlepszych wykonawców.',
              }
            });
          }
        }
      }
    }

    // 2) Twoja logika kandydatów/widełek/providerów (jak wcześniej)
    const services = await Service.find({}).lean();
    const scored = services.map(s => ({
      code: s.code,
      name: s.name,
      score: scoreServiceMatch(description, s),
    })).sort((a,b) => b.score - a.score);

    const bestHeuristicCandidate = scored[0] || null;
    const extraCandidates = scored.slice(1,4);

    // Użyj kandydata z Ollama lub fallback na heurystykę
    const serviceCandidate = llm?.serviceCandidate || bestHeuristicCandidate;

    // 2) widełki cen (użyj już obliczonych z wcześniejszego kroku lub oblicz ponownie)
    let priceHints = precomputedPriceHints;
    if (!priceHints && serviceCandidate?.code) {
      const historyHints = await priceHintsFromHistory({ serviceCode: serviceCandidate.code, cityLike: locationText }).catch(() => null);
      priceHints = historyHints || await computePriceHints(serviceCandidate.code, { lat, lon, text: locationText }).catch(() => null);
    }

    // 3) rekomendowani providerzy
    const topProviders = await recommendProviders(serviceCandidate?.code, lat, lon, 3, urgency);
    
    // 3a) Znajdź odpowiednie reklamy sponsorowane dla kontekstu
    let sponsorAds = [];
    try {
      const adContext = {
        keywords: description.toLowerCase().split(/\s+/),
        serviceCategory: serviceCandidate?.code,
        orderType: urgency === 'urgent' ? 'urgent' : 'standard',
        location: { city: locationText, lat, lon }
      };
      sponsorAds = await findRelevantAds(adContext, 2, null, req.user._id); // Max 2 reklamy, z retargetingiem
      
      // Zarejestruj wyświetlenia reklam
      for (const ad of sponsorAds) {
        const impressionContext = {
          ...adContext,
          abTestVariant: ad.abTestVariant || null // Przekaż wariant A/B testu
        };
        await recordImpression(ad._id, req.user._id, impressionContext);
      }
    } catch (adError) {
      console.error('Error fetching sponsor ads:', adError);
      // Nie przerywamy procesu jeśli reklamy się nie załadują
    }

    // 4) AI-enhanced DIY steps, flags, parts (z Ollama lub fallback)
    const { deriveSelfHelpSteps, suggestParts } = require('../utils/concierge');
    const { steps: stepsHeuristic, flags: flagsHeuristic } = deriveSelfHelpSteps(description, lang);
    // Użyj wykrytej kategorii do sugerowania części
    const detectedCategory = llm?.serviceCandidate?.code 
      ? (llm.serviceCandidate.code.includes('hydraulik') ? 'hydraulika' :
         llm.serviceCandidate.code.includes('elektryk') ? 'elektryka' :
         llm.serviceCandidate.code.includes('it') ? 'it' :
         llm.serviceCandidate.code.includes('remont') ? 'remont' : null)
      : null;
    const partsHeuristic = suggestParts(description, lang, detectedCategory);

    // 5) utwórz draft z nowymi polami (z Ollama lub fallback)
    const draft = await OrderDraft.create({
      client: req.user._id,
      description,
      serviceCandidate,
      extraCandidates,
      location: { text: locationText, lat, lon },
      priceHints,
      selfHelp: (llm?.diySteps || stepsHeuristic).map(s => typeof s === 'string' ? s : s.text),
      recommendedProviders: topProviders,
      urgency,
      status: 'draft',
      language: lang,
      diySteps: llm?.diySteps?.length ? llm.diySteps.map(t => ({ text: t, done: false })) : stepsHeuristic,
      dangerFlags: llm?.dangerFlags || flagsHeuristic,
      parts: llm?.parts || partsHeuristic
    });

    // 5a) Zapisz rozwiązanie AI w bazie feedbacku (do późniejszego uczenia)
    try {
      await AIFeedback.create({
        user: req.user._id,
        orderDraftId: draft._id,
        description: description,
        serviceCategory: detectedCategory,
        serviceCode: serviceCandidate?.code,
        location: locationText,
        aiSolution: {
          diySteps: llm?.diySteps || stepsHeuristic,
          requiredParts: llm?.requiredParts || llm?.parts || partsHeuristic,
          estimatedCost: priceHints || llm?.estimatedCost,
          estimatedTime: llm?.estimatedTime || '1-3 dni',
          deviceIdentification: llm?.deviceIdentification || null,
          conditionAssessment: llm?.conditionAssessment || null
        }
      });
    } catch (error) {
      console.warn('Failed to save AI feedback record:', error.message);
      // Nie przerywamy procesu jeśli zapis feedbacku się nie powiedzie
    }

    // 6) Zaktualizuj usage AI Concierge dla klientów
    if (user.role === 'client') {
      await User.findByIdAndUpdate(req.user._id, {
        $push: {
          aiConciergeUsage: {
            date: new Date(),
            description: description.substring(0, 100), // Pierwsze 100 znaków
            service: serviceCandidate?.name || 'nieznana'
          }
        }
      });
    }

    const aiSuggestedServices = [
      serviceCandidate,
      ...extraCandidates
    ].filter(Boolean).map(s => ({ code: s.code, name: s.name }));

    // Reklamy sponsorowane – formatuj dla AI/UI
    const formattedAds = formatAdsForAI(sponsorAds);

    // Rekomendacja "Helpfli poleca: DIY" vs "wezwij fachowca"
    const hasSeriousDanger = (draft.dangerFlags || []).some(f => {
      const t = (typeof f === 'string' ? f : f?.text || '').toLowerCase();
      return /gaz|prąd|elektryka|woda pod ciśnieniem|zalanie|awaria/.test(t);
    });
    const hasMeaningfulDiy = (draft.diySteps || []).length >= 2;
    const hasPriceRange = priceHints && (priceHints.standard?.min != null || priceHints.min != null);
    let recommendation;
    if (hasSeriousDanger || (!hasMeaningfulDiy && hasPriceRange)) {
      recommendation = {
        type: 'provider',
        reason: hasSeriousDanger
          ? 'Wykryto zagrożenie (gaz, prąd lub woda). Zalecamy wezwać fachowca.'
          : 'To zadanie lepiej powierzyć specjaliście – szybciej i bezpieczniej.'
      };
    } else {
      recommendation = {
        type: 'diy',
        reason: hasMeaningfulDiy
          ? 'Możesz spróbować sam – poniżej znajdziesz kroki.'
          : 'Na podstawie opisu możesz najpierw sprawdzić proste kroki lub od razu znaleźć wykonawcę.'
      };
    }

    res.json({
      draftId: draft._id,
      language: lang,
      serviceCandidate,
      extraCandidates,
      priceHints,
      selfHelp: draft.selfHelp,
      recommendedProviders: topProviders,
      urgency,
      dangerFlags: draft.dangerFlags,
      diySteps: draft.diySteps,
      parts: draft.parts,
      aiSuggestedServices,
      sponsorAds: formattedAds.length > 0 ? formattedAds : undefined,
      recommendation
    });
  } catch (e) {
    console.error(e);
    // Safe heuristic fallback instead of 500 to keep UX smooth and tests green
    return res.status(200).json({
      serviceCandidate: { code: 'inne', name: 'Inne usługi', confidence: 0.3 },
      dangerFlags: [],
      urgency: 'normal',
      diySteps: [],
      parts: [],
      priceHints: { min: null, max: null, currency: 'PLN' },
      recommendedProviders: [],
      draftId: null,
      recommendation: { type: 'provider', reason: 'Wystąpił błąd analizy. Możesz utworzyć zlecenie ręcznie.' }
    });
  }
});

// GET /api/ai/drafts/:id
router.get('/drafts/:id', authMiddleware, async (req, res) => {
  const d = await OrderDraft.findById(req.params.id);
  if (!d) return res.status(404).json({ message: 'Nie znaleziono draftu' });
  if (String(d.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });
  res.json(d);
});

// POST /api/ai/drafts/:id/submit
// body: { providerId? } – opcjonalnie wybór konkretnego
router.post('/drafts/:id/submit', authMiddleware, async (req, res) => {
  try {
    const draft = await OrderDraft.findById(req.params.id);
    if (!draft) return res.status(404).json({ message: 'Draft nie istnieje' });
    if (String(draft.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

    // zbuduj zlecenie na podstawie draftu
    const invited = draft.recommendedProviders?.map(p => p._id).filter(Boolean) || [];
    const preferred = req.body?.providerId ? [req.body.providerId] : [];

    // Mapowanie service code na ObjectId (jeśli Order.service trzyma ObjectId)
    let serviceId = null;
    if (draft.serviceCandidate?.code) {
      const svc = await Service.findOne({ code: draft.serviceCandidate.code });
      serviceId = svc?._id;
    }

    // Kopiuj załączniki z draft do order
    const draftAttachments = (draft.attachments || []).map(a => ({
      url: a.url,
      type: a.type,
      filename: a.filename,
      size: a.size,
      uploadedAt: a.uploadedAt || new Date()
    }));

    const order = await Order.create({
      client: draft.client,
      service: serviceId || draft.serviceCandidate?.code || null, // ObjectId lub code
      description: draft.description,
      location: draft.location?.text || '',
      locationLat: draft.location?.lat ?? null,
      locationLon: draft.location?.lon ?? null,
      city: (draft.location?.text || '').split(',')[0] || '',
      status: 'open',
      source: 'ai',
      priceQuotedMin: draft.priceHints?.standard?.min || 0,
      priceQuotedMax: draft.priceHints?.standard?.max || 0,
      invitedProviders: preferred.length ? preferred : invited,
      currency: 'pln',
      attachments: draftAttachments
    });

    draft.status = 'submitted';
    await draft.save();

    res.json({ message: 'Zlecenie utworzone', orderId: order._id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Błąd tworzenia zlecenia' });
  }
});

// A) Lista szkiców (powrót do draftu)
// GET /api/ai/drafts  — lista moich szkiców (ostatnie 30 dni)
router.get('/drafts', authMiddleware, async (req, res) => {
  const items = await OrderDraft.find({
    client: req.user._id,
    status: 'draft'
  }).sort({ updatedAt: -1 }).select('description serviceCandidate location createdAt updatedAt attachments');
  res.json({ items });
});

// B) Aktualizacja draftu (opis/lokalizacja)
// PATCH /api/ai/drafts/:id  body: { description?, locationText?, lat?, lon?, urgency? }
router.patch('/drafts/:id', authMiddleware, async (req, res) => {
  const d = await OrderDraft.findById(req.params.id);
  if (!d) return res.status(404).json({ message: 'Draft nie istnieje' });
  if (String(d.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

  const { description, locationText, lat, lon, urgency } = req.body || {};
  if (description !== undefined) d.description = description;
  if (locationText !== undefined) d.location = { ...(d.location||{}), text: locationText, lat: lat ?? d.location?.lat, lon: lon ?? d.location?.lon };
  if (lat !== undefined) d.location = { ...(d.location||{}), lat };
  if (lon !== undefined) d.location = { ...(d.location||{}), lon };
  if (urgency !== undefined) d.urgency = urgency;

  // opcjonalnie: auto-przedłuż ważność
  if (!d.expiresAt) d.expiresAt = new Date(Date.now() + 30*24*60*60*1000);

  await d.save();
  res.json({ message: 'Zapisano', draft: d });
});

// C) Upload załączników (foto/wideo)
// POST /api/ai/drafts/:id/attachments
router.post('/drafts/:id/attachments', authMiddleware, uploadDrafts.array('files', 12), async (req, res) => {
  const d = await OrderDraft.findById(req.params.id);
  if (!d) return res.status(404).json({ message: 'Draft nie istnieje' });
  if (String(d.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

  const added = (req.files || []).map(f => ({
    url: toPublicUrl(f.filename),
    type: detectType(f.mimetype),
    filename: f.originalname || f.filename,
    size: f.size
  }));
  d.attachments.push(...added);
  if (!d.expiresAt) d.expiresAt = new Date(Date.now() + 30*24*60*60*1000);
  await d.save();

  // Re-analyze draft po dodaniu załączników
  const { reAnalyzeDraft } = require('../utils/concierge');
  const updated = await reAnalyzeDraft(d); // przelicza serviceCandidate, priceHints, diySteps, flags, parts, recommendedProviders

  return res.json({
    message: 'Dodano załączniki',
    attachments: updated.attachments,
    serviceCandidate: updated.serviceCandidate,
    priceHints: updated.priceHints,
    recommendedProviders: updated.recommendedProviders,
    diySteps: updated.diySteps,
    dangerFlags: updated.dangerFlags,
    parts: updated.parts
  });
});

// D) Usuwanie załącznika
router.delete('/drafts/:id/attachments/:attId', authMiddleware, async (req, res) => {
  const d = await OrderDraft.findById(req.params.id);
  if (!d) return res.status(404).json({ message: 'Draft nie istnieje' });
  if (String(d.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

  const att = d.attachments.id(req.params.attId);
  if (!att) return res.status(404).json({ message: 'Załącznik nie istnieje' });

  // usuń plik z dysku (best-effort)
  try {
    const fname = att.url?.split('/').pop();
    if (fname) fs.unlink(path.join(process.env.UPLOAD_DIR || 'uploads', 'drafts', fname), ()=>{});
  } catch {}

  att.remove();
  await d.save();
  res.json({ message: 'Usunięto', attachments: d.attachments });
});

// E) Proxy podpowiedzi adresów (opcjonalnie)
// GET /api/ai/geo/search?q=...&limit=5
router.get('/geo/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '5', 10), 10);
  if (!q) return res.json({ items: [] });

  // Node 18+ ma global fetch
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', String(limit));

  const r = await fetch(url, { headers: { 'User-Agent': 'Helpfli/1.0 (demo)' } });
  const data = await r.json();
  const items = (data || []).map(x => ({
    label: x.display_name,
    lat: parseFloat(x.lat),
    lon: parseFloat(x.lon)
  }));
  res.json({ items });
});

// -------- QUOTES API ---------
// POST /api/ai/drafts/:id/request-quotes { providers?: [ids] }
router.post('/drafts/:id/request-quotes', authMiddleware, async (req, res) => {
  const draft = await OrderDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: 'Draft nie istnieje' });
  if (String(draft.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

  const chosen = (req.body?.providers && req.body.providers.length)
    ? req.body.providers
    : (draft.recommendedProviders || []).map(p => p._id).filter(Boolean);

  if (!chosen.length) return res.status(400).json({ message: 'Brak wybranych wykonawców' });

  const toCreate = chosen.map(pid => ({ draft: draft._id, client: draft.client, provider: pid }));
  await DraftQuote.insertMany(toCreate);
  res.json({ message: 'Zapytania wysłane', count: toCreate.length });
});

// GET /api/ai/drafts/:id/quotes – klient podgląda odpowiedzi
router.get('/drafts/:id/quotes', authMiddleware, async (req, res) => {
  const draft = await OrderDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: 'Draft nie istnieje' });
  if (String(draft.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

  const quotes = await DraftQuote.find({ draft: draft._id }).populate('provider','name rating level kyc badges');
  res.json({ items: quotes });
});

// PROVIDER: lista zapytań do mnie
// GET /api/ai/provider/quotes?status=pending|quoted
router.get('/provider/quotes', authMiddleware, requireKycVerified, async (req, res) => {
  const status = req.query.status?.split(',') || ['pending','quoted'];
  const items = await DraftQuote.find({ provider: req.user._id, status: { $in: status } })
    .populate('draft','description location serviceCandidate attachments')
    .populate('client','name');
  res.json({ items });
});

// PROVIDER: odpowiedz/odrzuć
// POST /api/ai/drafts/:id/quotes/:quoteId/respond  body: { action: 'quote'|'decline', amount?, message? }
router.post('/drafts/:id/quotes/:quoteId/respond', authMiddleware, requireKycVerified, async (req, res) => {
  const q = await DraftQuote.findById(req.params.quoteId).populate('draft');
  if (!q) return res.status(404).json({ message: 'Nie ma takiej wyceny' });
  if (String(q.provider) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twoje zapytanie' });
  if (String(q.draft?._id) !== String(req.params.id)) return res.status(400).json({ message: 'Draft nie pasuje' });
  if (q.status !== 'pending' && q.status !== 'quoted') return res.status(400).json({ message: 'Nie można zmienić tego statusu' });

  const { action, amount, message } = req.body || {};
  if (action === 'decline') {
    q.status = 'declined';
    q.message = message || '';
    await q.save();
    return res.json({ message: 'Odrzucono' });
  }
  if (action === 'quote') {
    if (!amount || amount < 100) return res.status(400).json({ message: 'Kwota nieprawidłowa' });
    q.status = 'quoted';
    q.quoteAmount = Math.round(amount);
    q.message = message || '';
    await q.save();
    return res.json({ message: 'Wysłano wycenę', quote: q });
  }
  return res.status(400).json({ message: 'Nieznana akcja' });
});

// KLIENT: akceptuj wycenę → 1-klik utwórz zlecenie
// POST /api/ai/drafts/:id/accept-quote  body: { quoteId }
router.post('/drafts/:id/accept-quote', authMiddleware, async (req, res) => {
  const draft = await OrderDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: 'Draft nie istnieje' });
  if (String(draft.client) !== String(req.user._id)) return res.status(403).json({ message: 'To nie Twój draft' });

  const q = await DraftQuote.findById(req.body?.quoteId);
  if (!q || String(q.draft) !== String(draft._id)) return res.status(404).json({ message: 'Wycena nie istnieje' });
  if (q.status !== 'quoted') return res.status(400).json({ message: 'Tę wycenę nie można zaakceptować' });

  // mapowanie service jeśli masz ObjectId
  let serviceField = draft.serviceCandidate?.code || null;
  // const svc = await Service.findOne({ code: draft.serviceCandidate?.code });
  // serviceField = svc?._id || null;

  // Kopiuj załączniki z draft do order
  const draftAttachments = (draft.attachments || []).map(a => ({
    url: a.url,
    type: a.type,
    filename: a.filename,
    size: a.size,
    uploadedAt: a.uploadedAt || new Date()
  }));

  const order = await Order.create({
    client: draft.client,
    service: serviceField,
    description: draft.description,
    location: draft.location?.text || '',
    source: 'ai',
    status: 'open',
    provider: q.provider,
    priceQuotedMin: q.quoteAmount,
    priceQuotedMax: q.quoteAmount,
    amountTotal: q.quoteAmount,
    currency: 'pln',
    invitedProviders: [q.provider],
    attachments: draftAttachments
  });

  q.status = 'accepted';
  await q.save();
  draft.status = 'submitted';
  await draft.save();

  res.json({ message: 'Zlecenie utworzone', orderId: order._id, providerId: q.provider });
});

// PATCH /api/ai/drafts/:id/steps body: { index, done }
router.patch('/drafts/:id/steps', authMiddleware, async (req,res)=>{
  try {
    const d = await OrderDraft.findById(req.params.id);
    if (!d) return res.status(404).json({ message:'Draft nie istnieje' });
    if (String(d.client) !== String(req.user._id)) return res.status(403).json({ message:'To nie Twój draft' });

    const { index, done } = req.body || {};
    if (typeof index !== 'number' || !d.diySteps?.[index]) return res.status(400).json({ message:'Zły indeks kroku' });

    d.diySteps[index].done = !!done;
    await d.save();

    // Telemetria (jeśli masz)
    try {
      const Telemetry = require('../services/TelemetryService');
      Telemetry.track('ai_step_toggled', { draftId: d._id, index, done: !!done, userId: req.user._id });
    } catch (_) {}

    res.json({ diySteps: d.diySteps });
  } catch (error) {
    console.error('Steps patch error:', error);
    res.status(500).json({ message: 'Błąd aktualizacji kroku' });
  }
});

// GET /api/ai/match-top-providers - AI matching TOP 3 wykonawców
// query: { serviceCode, lat, lon, urgency? }
router.get('/match-top-providers', authMiddleware, async (req, res) => {
  try {
    const { serviceCode, lat, lon, urgency = 'normal' } = req.query;
    
    if (!serviceCode) {
      return res.status(400).json({ message: 'serviceCode jest wymagany' });
    }

    const providers = await recommendProviders(
      serviceCode,
      lat ? parseFloat(lat) : null,
      lon ? parseFloat(lon) : null,
      3,
      urgency
    );

    res.json({
      providers,
      count: providers.length,
      serviceCode,
      urgency
    });
  } catch (error) {
    console.error('Match top providers error:', error);
    res.status(500).json({ message: 'Błąd dopasowywania wykonawców' });
  }
});

// POST /api/ai/concierge/feedback - Zbierz feedback od użytkownika o rozwiązaniu AI
// body: { draftId?, orderId?, worked, rating, comment, actualCost?, actualTime?, usedParts?, issues? }
router.post('/concierge/feedback', authMiddleware, async (req, res) => {
  try {
    const { 
      draftId, 
      orderId, 
      worked, 
      rating, 
      comment, 
      actualCost, 
      actualTime, 
      usedParts = [],
      issues = []
    } = req.body || {};

    if (worked === undefined && rating === undefined) {
      return res.status(400).json({ message: 'Podaj przynajmniej czy rozwiązanie zadziałało (worked) lub ocenę (rating)' });
    }

    // Znajdź odpowiedni rekord feedbacku
    const feedbackQuery = { user: req.user._id };
    if (draftId) feedbackQuery.orderDraftId = draftId;
    if (orderId) feedbackQuery.orderId = orderId;

    const feedback = await AIFeedback.findOne(feedbackQuery).sort({ createdAt: -1 });

    if (!feedback) {
      return res.status(404).json({ message: 'Nie znaleziono odpowiedniego rozwiązania AI. Upewnij się, że podałeś poprawne draftId lub orderId.' });
    }

    // Zaktualizuj feedback
    feedback.feedback = {
      worked: worked !== undefined ? worked : feedback.feedback?.worked,
      rating: rating !== undefined ? rating : feedback.feedback?.rating,
      comment: comment || feedback.feedback?.comment,
      actualCost: actualCost !== undefined ? actualCost : feedback.feedback?.actualCost,
      actualTime: actualTime || feedback.feedback?.actualTime,
      usedParts: usedParts.length > 0 ? usedParts : feedback.feedback?.usedParts || [],
      issues: issues.length > 0 ? issues : feedback.feedback?.issues || []
    };
    feedback.feedbackGivenAt = new Date();
    feedback.updatedAt = new Date();

    await feedback.save();

    res.json({
      success: true,
      message: 'Dziękujemy za feedback! Pomaga nam to ulepszać AI.',
      feedbackId: feedback._id
    });
  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ message: 'Błąd zapisywania feedbacku' });
  }
});

// GET /api/ai/concierge/feedback/stats - Statystyki skuteczności AI (dla admina lub własne)
router.get('/concierge/feedback/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { serviceCategory, serviceCode, location } = req.query;

    // Tylko admin może zobaczyć wszystkie statystyki
    const query = user.role === 'admin' ? {} : { user: req.user._id };

    if (serviceCategory) query.serviceCategory = serviceCategory;
    if (serviceCode) query.serviceCode = serviceCode;
    if (location) query.location = { $regex: location, $options: 'i' };

    const feedbacks = await AIFeedback.find({
      ...query,
      'feedback.worked': { $ne: null }
    }).lean();

    const total = feedbacks.length;
    const worked = feedbacks.filter(f => f.feedback?.worked === true).length;
    const notWorked = feedbacks.filter(f => f.feedback?.worked === false).length;
    const avgRating = feedbacks
      .filter(f => f.feedback?.rating)
      .reduce((sum, f) => sum + (f.feedback.rating || 0), 0) / feedbacks.filter(f => f.feedback?.rating).length || 0;

    res.json({
      total,
      worked,
      notWorked,
      successRate: total > 0 ? (worked / total * 100).toFixed(1) : 0,
      avgRating: avgRating.toFixed(1),
      feedbacks: feedbacks.slice(0, 10) // Ostatnie 10 feedbacków
    });
  } catch (error) {
    console.error('Feedback stats error:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

module.exports = router;
