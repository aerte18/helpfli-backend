const express = require("express");
const mongoose = require("mongoose");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const { requireKycVerified } = require("../middleware/kyc");
const Offer = require("../models/Offer");
const Order = require("../models/Order");
const User = require("../models/User");
const Revenue = require("../models/Revenue");
const { computePricingBands } = require("../utils/pricing");
const { notifyOfferNew, notifyOfferAccepted } = require("../utils/notifier");
const logger = require("../utils/logger");
const { evaluateOfferPreflight, normalizeOfferQuality } = require("../ai/utils/preflightQualityEvaluator");

// Helper function: Calculate distance between two coordinates (Haversine formula)
function calculateDistance(coord1, coord2) {
  const R = 6371; // Earth radius in km
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;
  
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

function normalizeOfferAiQuality(aiQuality) {
  return normalizeOfferQuality(aiQuality) || undefined;
}

const router = express.Router();

router.get("/hint", auth, async (req, res) => {
  try {
    const { orderId } = req.query || {};
    if (!orderId) return res.status(400).json({ message: "Brak orderId" });
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const service = order.service || "inne";
    const city = order?.location?.city || null;
    const lat = order?.location?.coords?.coordinates?.[1] ?? null;
    const lng = order?.location?.coords?.coordinates?.[0] ?? null;
    const urgency = order.urgency && ["normal", "today", "now"].includes(order.urgency) ? order.urgency : "normal";

    const bands = await computePricingBands({ service, city, lat, lng, urgency });
    res.json(bands);
  } catch (e) {
    logger.error("OFFERS_HINT_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.query?.orderId
    });
    res.status(500).json({ message: "Błąd pobierania widełek" });
  }
});

// GET /api/offers/analyze-order - AI analiza zlecenia i sugestie dla oferty
router.get("/analyze-order", auth, async (req, res) => {
  try {
    const { orderId } = req.query || {};
    if (!orderId) return res.status(400).json({ message: "Brak orderId" });
    
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });
    
    const provider = await User.findById(req.user._id).lean();
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: "Tylko providerzy mogą analizować zlecenia" });
    }
    
    // Pobierz widełki cenowe
    const service = order.service || "inne";
    const city = order?.location?.city || null;
    const lat = order?.location?.coords?.coordinates?.[1] ?? null;
    const lng = order?.location?.coords?.coordinates?.[0] ?? null;
    const urgency = order.urgency && ["normal", "today", "now"].includes(order.urgency) ? order.urgency : "normal";
    
    const bands = await computePricingBands({ service, city, lat, lng, urgency });
    
    // Przygotuj kontekst dla AI
    const orderContext = {
      service: typeof order.service === 'object' ? order.service?.code : order.service,
      description: order.description || '',
      urgency: order.urgency || 'normal',
      location: order.location?.city || order.location?.address || 'Nieznana',
      budget: order.budget || order.budgetRange,
      paymentPreference: order.paymentPreference || 'system',
      contactPreference: order.contactPreference || null,
      attachments: order.attachments?.length || 0,
      priorityDateTime: order.priorityDateTime || null, // Termin wybrany przez klienta
      clientPreferredTerm: order.priorityDateTime ? new Date(order.priorityDateTime).toISOString() : null
    };
    
    const providerInfo = {
      name: provider.name,
      level: provider.providerLevel || provider.providerTier || 'standard',
      rating: provider.rating || 0
    };
    
    // Wywołaj AI agent do analizy zlecenia i generowania sugestii
    let aiSuggestions = null;
    try {
      const { runOfferAgent } = require('../ai/agents/offerAgent');
      
      aiSuggestions = await runOfferAgent({
        orderContext,
        providerInfo,
        existingOffers: [],
        conversationHistory: []
      });
    } catch (error) {
      console.error('AI agent error, using fallback:', error);
      // Fallback - podstawowe sugestie
      aiSuggestions = {
        suggestedPrice: {
          recommended: bands?.stats?.adjusted?.med || 200,
          min: bands?.stats?.adjusted?.min || 100,
          max: bands?.stats?.adjusted?.max || 500,
          reasoning: 'Cena oparta na analizie rynku lokalnego'
        },
        suggestedDescription: 'Opisz dokładnie zakres prac, materiały wliczone w cenę, czas realizacji i gwarancję.',
        suggestedTimeline: '3-5 dni',
        tips: [
          'Dodaj informację o doświadczeniu w podobnych zleceniach',
          'Wymień materiały wliczone w cenę',
          'Zaproponuj gwarancję na wykonane prace',
          'Bądź konkretny co do terminu realizacji'
        ]
      };
    }
    
    // Przygotuj odpowiedź
    const response = {
      orderSummary: {
        service: orderContext.service,
        description: orderContext.description,
        location: orderContext.location,
        budget: orderContext.budget,
        urgency: orderContext.urgency,
        paymentPreference: orderContext.paymentPreference,
        hasAttachments: orderContext.attachments > 0
      },
      pricing: {
        suggested: aiSuggestions?.suggestedPrice?.recommended || bands?.stats?.adjusted?.med || 200,
        range: {
          min: aiSuggestions?.suggestedPrice?.min || bands?.stats?.adjusted?.min || 100,
          max: aiSuggestions?.suggestedPrice?.max || bands?.stats?.adjusted?.max || 500
        },
        reasoning: aiSuggestions?.suggestedPrice?.reasoning || 'Cena oparta na analizie rynku lokalnego'
      },
      suggestions: {
        description: aiSuggestions?.suggestedDescription || 'Opisz dokładnie zakres prac, materiały wliczone w cenę, czas realizacji i gwarancję.',
        timeline: aiSuggestions?.suggestedTimeline || '3-5 dni',
        completionDate: aiSuggestions?.suggestedCompletionDate || null, // Sugerowany termin realizacji (może być termin klienta)
        tips: aiSuggestions?.tips || [
          'Dodaj informację o doświadczeniu w podobnych zleceniach',
          'Wymień materiały wliczone w cenę',
          'Zaproponuj gwarancję na wykonane prace',
          'Bądź konkretny co do terminu realizacji'
        ],
        scope: aiSuggestions?.suggestedScope || [],
        questions: aiSuggestions?.questions || [],
        risks: aiSuggestions?.risks || [],
        checklist: aiSuggestions?.checklist || [],
        winScore: aiSuggestions?.winScore || null,
        winLabel: aiSuggestions?.winLabel || null,
        recommendedIncludes: aiSuggestions?.recommendedIncludes || ['labor', 'transport'],
        recommendedContactMethod: aiSuggestions?.recommendedContactMethod || 'chat_only',
        isFinalPriceRecommended: aiSuggestions?.isFinalPriceRecommended ?? true
      },
      marketData: {
        sampleSize: bands?.stats?.sample || 0,
        median: bands?.stats?.adjusted?.med || 200
      }
    };
    
    res.json(response);
  } catch (e) {
    logger.error("OFFERS_ANALYZE_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.query?.orderId
    });
    res.status(500).json({ message: "Błąd analizy zlecenia" });
  }
});

// POST /api/offers/preflight-quality - AI ocena jakości oferty przed wysłaniem
router.post("/preflight-quality", auth, async (req, res) => {
  try {
    const { orderId, amount, message, completionDate, priceIncludes, isFinalPrice, contactMethod } = req.body || {};
    if (!orderId) return res.status(400).json({ message: "Brak orderId" });

    const provider = await User.findById(req.user._id).lean();
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: "Tylko providerzy mogą używać preflight AI" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const quality = await evaluateOfferPreflight({
      orderContext: {
        service: typeof order.service === 'object' ? order.service?.code : order.service,
        description: order.description || '',
        urgency: order.urgency || 'normal',
        location: order.location?.city || order.location?.address || '',
        budget: order.budget || order.budgetRange || null
      },
      offerDraft: {
        amount,
        message,
        completionDate,
        priceIncludes,
        isFinalPrice,
        contactMethod,
        providerLevel: provider.providerLevel || provider.providerTier || 'standard'
      }
    });

    return res.json({ quality });
  } catch (e) {
    logger.error("OFFERS_PREFLIGHT_QUALITY_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.body?.orderId,
      providerId: req.user?._id
    });
    return res.status(500).json({ message: "Błąd preflight quality" });
  }
});

router.post("/", auth, async (req, res) => {
  try {
    // MVP Fields (nowe) + Legacy fields (kompatybilność wsteczna)
    const { 
      orderId, 
      price, // MVP: nowe pole
      amount, // Legacy: alias dla price
      etaMinutes, // MVP: nowe pole (Estimated Time of Arrival w minutach)
      notes, // MVP: nowe pole
      message, // Legacy: alias dla notes
      completionDate, // Legacy: termin realizacji
      hasGuarantee = false, // MVP: nowe pole
      guaranteeDetails = "", // MVP: nowe pole
      paymentMethod, // Metoda płatności wybrana przez providera (tylko jeśli klient wybrał "both")
      aiQuality,
      boost = false 
    } = req.body || {};
    
    // Walidacja MVP
    if (!orderId) return res.status(400).json({ message: "Brak orderId" });
    if (!price && !amount) return res.status(400).json({ message: "Brak price lub amount" });
    if (!etaMinutes && !completionDate) return res.status(400).json({ message: "Brak etaMinutes lub completionDate" });
    
    // Normalizacja: użyj nowych pól jeśli dostępne, w przeciwnym razie legacy
    const finalPrice = price || amount;
    const finalNotes = notes || message || "";
    const finalEtaMinutes = etaMinutes || (completionDate ? Math.round((new Date(completionDate) - new Date()) / (1000 * 60)) : null);
    
    if (!finalEtaMinutes || finalEtaMinutes < 0) {
      return res.status(400).json({ message: "etaMinutes musi być dodatnią liczbą" });
    }
    
    // Sprawdź limity ofert miesięcznie
    const provider = await User.findById(req.user._id);
    if (!provider) return res.status(404).json({ message: "Provider nie istnieje" });
    
    // Sprawdź czy nie przekroczył limitu ofert w tym miesiącu
    if (provider.monthlyOffersUsed >= provider.monthlyOffersLimit) {
      // Utwórz powiadomienie zamiast zwracania błędu
      const Notification = require('../models/Notification');
      const remaining = provider.monthlyOffersLimit - provider.monthlyOffersUsed;
      
      // Sprawdź czy już nie ma powiadomienia o przekroczeniu limitu (aby nie spamować)
      const existingNotification = await Notification.findOne({
        user: req.user._id,
        type: 'limit_exceeded',
        read: false,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Ostatnie 24h
      });
      
      if (!existingNotification) {
        let suggestion = null;
        if (provider.providerTier === 'basic') {
          suggestion = {
            recommendedPlanKey: 'PROV_STD',
            title: 'Standard (50 odpowiedzi / mies.)',
            description: 'Zwiększ limit odpowiedzi i odblokuj statystyki skuteczności ofert.'
          };
        } else if (provider.providerTier === 'standard') {
          suggestion = {
            recommendedPlanKey: 'PROV_PRO',
            title: 'PRO (nielimitowane odpowiedzi)',
            description: 'Nielimitowane odpowiedzi, priorytet w wynikach i Gwarancja Helpfli+.'
          };
        }
        
        await Notification.create({
          user: req.user._id,
          type: 'limit_exceeded',
          title: 'Przekroczono limit ofert',
          message: `Wykorzystałeś wszystkie oferty w tym miesiącu (${provider.monthlyOffersLimit}). Ulepsz pakiet aby zwiększyć limit.`,
          link: '/account/subscriptions',
          metadata: {
            limit: provider.monthlyOffersLimit,
            used: provider.monthlyOffersUsed,
            providerTier: provider.providerTier || 'basic',
            upsell: suggestion
          }
        });
      }

      return res.status(403).json({ 
        message: `Przekroczono limit ofert miesięcznie (${provider.monthlyOffersLimit}). Sprawdź powiadomienia aby zobaczyć szczegóły.`
      });
    }
    
    // Sprawdź czy limit jest niski (mniej niż 20% pozostało) i wyślij ostrzeżenie
    const remaining = provider.monthlyOffersLimit - provider.monthlyOffersUsed;
    const warningThreshold = Math.max(1, Math.floor(provider.monthlyOffersLimit * 0.2)); // 20% lub minimum 1
    
    if (remaining <= warningThreshold && remaining > 0) {
      const Notification = require('../models/Notification');
      
      // Sprawdź czy już nie ma powiadomienia o niskim limicie (aby nie spamować)
      const existingWarning = await Notification.findOne({
        user: req.user._id,
        type: 'limit_warning',
        read: false,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Ostatnie 24h
      });
      
      if (!existingWarning) {
        await Notification.create({
          user: req.user._id,
          type: 'limit_warning',
          title: 'Niski limit ofert',
          message: `Zostało Ci ${remaining} z ${provider.monthlyOffersLimit} ofert w tym miesiącu. Rozważ ulepszenie pakietu.`,
          link: '/account/subscriptions',
          metadata: {
            limit: provider.monthlyOffersLimit,
            used: provider.monthlyOffersUsed,
            remaining: remaining
          }
        });
      }
    }
    
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const service = order.service || "inne";
    const city = order?.location?.city || null;
    const lat = order?.location?.coords?.coordinates?.[1] ?? null;
    const lng = order?.location?.coords?.coordinates?.[0] ?? null;
    const urgency = order.urgency && ["normal", "today", "now"].includes(order.urgency) ? order.urgency : "normal";

    const bandsObj = await computePricingBands({ service, city, lat, lng, urgency });
    const a = Number(finalPrice);
    const adj = bandsObj.stats.adjusted;
    const within = (x, lo, hi) => x >= lo && x <= hi;

    let position = "fair";
    if (a < adj.min) position = "below_min";
    else if (a >= adj.min && a < (adj.p25 ?? Math.round(adj.med * 0.85))) position = "low";
    else if (within(a, (adj.p25 ?? Math.round(adj.med * 0.9)), (adj.p75 ?? Math.round(adj.med * 1.1)))) position = "fair";
    if (within(a, Math.round(adj.med * 0.95), Math.round(adj.med * 1.05))) position = "optimal";
    else if (a > (adj.p75 ?? Math.round(adj.med * 1.15)) && a <= adj.max) position = "high";
    else if (a > adj.max) position = "above_max";

    let badge = "";
    if (position === "optimal") badge = "optimal";
    else if (position === "fair") badge = "fair";
    else if (position === "low") badge = "low";
    else if (position === "high") badge = "high";

    // Sprawdź czy provider ma pakiet, który obejmuje boost
    let finalBoostFee = 0;
    if (boost) {
      const provider = await User.findById(req.user._id);
      
      // Sprawdź subskrypcję
      const UserSubscription = require('../models/UserSubscription');
      const subscription = await UserSubscription.findOne({ 
        user: req.user._id,
        validUntil: { $gt: new Date() }
      });
      
      const packageType = subscription?.planKey || 'PROV_FREE';
      const isPro = packageType === 'PROV_PRO';
      
      if (isPro) {
        finalBoostFee = 0; // Pakiet PRO obejmuje boost
      } else {
        finalBoostFee = 500; // 5 zł w groszach
      }
    }

    // Oblicz completionDate z etaMinutes jeśli nie podano
    const finalCompletionDate = completionDate 
      ? new Date(completionDate) 
      : new Date(Date.now() + finalEtaMinutes * 60 * 1000);
    const normalizedAiQuality = normalizeOfferAiQuality(aiQuality);
    
    const created = await Offer.create({
      orderId,
      providerId: req.user._id,
      // MVP Fields
      price: finalPrice,
      etaMinutes: finalEtaMinutes,
      notes: finalNotes,
      priceInfo: req.body.priceInfo || { includes: [], isFinal: true },
      contactMethod: req.body.contactMethod || null,
      ...(normalizedAiQuality ? { aiQuality: normalizedAiQuality } : {}),
      paymentMethod: paymentMethod || null, // Metoda płatności (tylko jeśli klient wybrał "both")
      hasGuarantee: hasGuarantee || false,
      guaranteeDetails: guaranteeDetails || "",
      status: 'sent',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h domyślnie
      // Legacy fields (kompatybilność wsteczna)
      amount: finalPrice,
      message: finalNotes,
      completionDate: finalCompletionDate,
      boostUntil: boost ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
      boostFee: finalBoostFee,
      pricing: {
        service,
        city,
        bands: { min: adj.min, p25: adj.p25 ?? null, med: adj.med, p75: adj.p75 ?? null, max: adj.max, k: bandsObj.stats.adjusted.k },
        position,
        badge,
      },
    });
    
    // Zmień status order na collecting_offers jeśli jeszcze open
    if (order.status === 'open' || order.status === 'draft') {
      order.status = 'collecting_offers';
      await order.save();
    }

    // Zwiększ licznik ofert miesięcznie
    provider.monthlyOffersUsed += 1;
    await provider.save();

    // Rejestruj przychód z boost oferty
    if (boost && finalBoostFee > 0) {
      await Revenue.create({
        orderId,
        clientId: order.client,
        providerId: req.user._id,
        type: "boost_fee",
        amount: finalBoostFee,
        description: `Boost oferty - ${service}`,
        status: "pending", // będzie zmienione na "paid" po płatności
        metadata: {
          boostFee: finalBoostFee,
          package: req.user.level || "standard",
          tier: req.user.providerTier || "basic"
        }
      });
    }

    // powiadom klientów obserwujących to zlecenie
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${orderId}`).emit("offer:new", {
        orderId,
        offerId: created._id,
        providerId: created.providerId,
        amount: created.amount,
        badge: created.pricing?.badge || "",
      });
    }

    // Wyślij powiadomienia email + push
    await notifyOfferNew({ app: req.app, orderId, offerId: created._id });

    // Zaawansowana porada cenowa z AI (jeśli dostępne)
    let pricingAdvice = null;
    try {
      const aiPricingService = require('../services/ai_pricing_service');
      pricingAdvice = await aiPricingService.generateAdvancedPricingAdvice({
        orderId,
        providerId: req.user._id,
        proposedAmount: a,
        orderDescription: order.description || order.title || ''
      });
    } catch (error) {
      logger.warn('AI pricing advice failed, using fallback:', error.message);
      // Fallback do podstawowej porady
      let adviceMessage = '';
      if (position === 'below_min' || position === 'low') {
        adviceMessage = 'Twoja oferta jest niższa niż typowe widełki dla podobnych zleceń. Rozważ lekkie podniesienie ceny, aby zwiększyć szansę akceptacji.';
      } else if (position === 'optimal' || position === 'fair') {
        adviceMessage = 'Twoja oferta mieści się w typowych widełkach – jest konkurencyjna cenowo.';
      } else if (position === 'high' || position === 'above_max') {
        adviceMessage = 'Twoja oferta jest wyższa niż większość podobnych zleceń. Dodaj uzasadnienie w opisie lub rozważ obniżenie ceny.';
      }

      pricingAdvice = {
        position,
        message: adviceMessage,
        suggestedMin: adj.min,
        suggestedMed: adj.med,
        suggestedMax: adj.max,
        aiEnhanced: false
      };
    }

    res.json({ 
      offer: created,
      pricingAdvice
    });
  } catch (e) {
    logger.error("CREATE_OFFER_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.body?.orderId,
      providerId: req.user?._id
    });
    res.status(500).json({ message: "Błąd zapisu oferty" });
  }
});

// POST /api/offers/:id/boost - boost oferty (płatne pozycjonowanie)
router.post("/:id/boost", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { durationHours = 24 } = req.body; // Domyślnie 24h
    
    const offer = await Offer.findById(id);
    if (!offer) {
      return res.status(404).json({ error: "Oferta nie znaleziona" });
    }
    
    // Sprawdź czy użytkownik jest właścicielem oferty
    if (String(offer.providerId) !== String(req.user._id)) {
      return res.status(403).json({ error: "Brak uprawnień" });
    }
    
    // Sprawdź czy oferta jest w statusie submitted
    if (offer.status !== 'submitted' && offer.status !== 'sent') {
      return res.status(400).json({ error: "Można boostować tylko oferty oczekujące ('sent' lub 'submitted')" });
    }
    
    // Oblicz cenę boosta (10 zł za 24h, proporcjonalnie)
    const boostPricePerHour = 1000 / 24; // 10 zł / 24h = ~0.42 zł/h (w groszach)
    const boostFee = Math.round(boostPricePerHour * durationHours);
    
    // Sprawdź pakiet użytkownika
    const UserSubscription = require('../models/UserSubscription');
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    const packageType = subscription?.planKey || 'PROV_FREE';
    const isPro = packageType === 'PROV_PRO';
    const isStandard = packageType === 'PROV_STD';
    
    const highlightedUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000);
    const paymentAmount = 500; // 5 zł w groszach
    let boostsRemaining = 0;
    
    // Sprawdź limity miesięczne i reset jeśli potrzeba
    const now = new Date();
    const resetDate = subscription?.freeOfferBoostsResetDate;
    const needsReset = !resetDate || 
      resetDate.getMonth() !== now.getMonth() || 
      resetDate.getFullYear() !== now.getFullYear();
    
    if (needsReset && subscription) {
      // Reset limitów na nowy miesiąc
      if (isPro) {
        subscription.freeOfferBoostsLimit = 10;
        subscription.freeOfferBoostsLeft = 10;
      } else if (isStandard) {
        subscription.freeOfferBoostsLimit = 5;
        subscription.freeOfferBoostsLeft = 5;
      } else {
        subscription.freeOfferBoostsLimit = 0;
        subscription.freeOfferBoostsLeft = 0;
      }
      subscription.freeOfferBoostsResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
      await subscription.save();
    }
    
    // Sprawdź czy może użyć darmowego wyróżnienia
    if (isPro && subscription?.freeOfferBoostsLeft > 0) {
      // PRO = darmowy boost (max 10/miesiąc)
      boostsRemaining = subscription.freeOfferBoostsLeft - 1;
      subscription.freeOfferBoostsLeft -= 1;
      await subscription.save();
      
      offer.highlighted = true;
      offer.highlightedUntil = highlightedUntil;
      offer.boostedAt = new Date();
      offer.boostFree = true;
      await offer.save();
      
      return res.json({ 
        message: `Oferta została wyróżniona (PRO - darmowo) • Pozostało ${boostsRemaining} wyróżnień`,
        offer,
        highlightedUntil: offer.highlightedUntil,
        requiresPayment: false,
        boostsRemaining: boostsRemaining
      });
    } else if (isStandard && subscription?.freeOfferBoostsLeft > 0) {
      // STANDARD = darmowy boost (max 5/miesiąc)
      boostsRemaining = subscription.freeOfferBoostsLeft - 1;
      subscription.freeOfferBoostsLeft -= 1;
      await subscription.save();
      
      offer.highlighted = true;
      offer.highlightedUntil = highlightedUntil;
      offer.boostedAt = new Date();
      offer.boostFree = true;
      await offer.save();
      
      return res.json({
        message: `Oferta została wyróżniona (STANDARD - darmowo) • Pozostało ${boostsRemaining} wyróżnień`,
        offer,
        highlightedUntil: offer.highlightedUntil,
        requiresPayment: false,
        boostsRemaining: boostsRemaining
      });
    }
    
    // Wymagana płatność (wyczerpane limity lub FREE)
    offer.highlighted = true;
    offer.highlightedUntil = highlightedUntil;
    offer.boostedAt = new Date();
    offer.boostFree = false;
    await offer.save();
    
    res.json({
      offer,
      requiresPayment: true,
      paymentAmount: paymentAmount,
      checkoutUrl: `/checkout?reason=offer_boost&offerId=${offer._id}&amount=${paymentAmount}`,
      highlightedUntil: offer.highlightedUntil,
      boostsRemaining: boostsRemaining,
      message: isPro || isStandard 
        ? `Wyczerpane darmowe limity (${isPro ? 'PRO: 10' : 'STANDARD: 5'}/miesiąc) • Wymagana płatność 5 zł`
        : 'Wymagana płatność 5 zł za wyróżnienie oferty'
    });
  } catch (error) {
    logger.error('BOOST_OFFER_ERROR:', {
      message: error.message,
      stack: error.stack,
      offerId: req.params?.id
    });
    res.status(500).json({ error: "Błąd boostowania oferty" });
  }
});

// GET /api/offers/my?orderId=... - pobierz ofertę providera dla danego zlecenia
// GET /api/offers/my - pobierz wszystkie oferty providera (bez orderId)
router.get("/my", auth, async (req, res) => {
  try {
    const { orderId } = req.query || {};
    
    // Jeśli podano orderId, zwróć jedną ofertę dla tego zlecenia
    if (orderId) {
      const offer = await Offer.findOne({
        orderId: new mongoose.Types.ObjectId(orderId),
        providerId: req.user._id
      })
      .populate('orderId', 'description service status client location createdAt')
      .lean();

      return res.json({ offer });
    }
    
    // Jeśli brak orderId, zwróć wszystkie oferty providera
    const offers = await Offer.find({
      providerId: req.user._id
    })
    .populate('orderId', 'description service status client location createdAt acceptedOfferId')
    .sort({ createdAt: -1 })
    .lean();

    res.json({ offers });
  } catch (e) {
    logger.error("GET_MY_OFFERS_ERROR:", {
      message: e.message,
      stack: e.stack,
      providerId: req.user?._id
    });
    res.status(500).json({ message: "Błąd pobierania ofert" });
  }
});

router.get("/of-order", auth, async (req, res) => {
  try {
    const { orderId } = req.query || {};
    if (!orderId) return res.status(400).json({ message: "Brak orderId" });

    const { shouldFilterDemoData, getDemoUserIds } = require("../utils/demoAccounts");
    const firstMatch = { orderId: new mongoose.Types.ObjectId(orderId) };
    if (shouldFilterDemoData(req.user)) {
      const demoIds = await getDemoUserIds();
      if (demoIds.length) firstMatch.providerId = { $nin: demoIds };
    }

    const items = await Offer.aggregate([
      { $match: firstMatch },
      // Sortuj: boostowane oferty (z ważnym boostUntil) na górze
      {
        $addFields: {
          isBoosted: {
            $and: [
              { $ne: ["$boostUntil", null] },
              { $gt: ["$boostUntil", new Date()] }
            ]
          }
        }
      },
      {
        $sort: {
          isBoosted: -1, // Boostowane na górze
          createdAt: -1
        }
      },
      // dociągamy usera (provider)
      {
        $lookup: {
          from: "users",
          localField: "providerId",
          foreignField: "_id",
          as: "provider",
        }
      },
      { $unwind: { path: "$provider", preserveNullAndEmptyArrays: true } },
      // dociągamy ratingi
      {
        $lookup: {
          from: "ratings",
          let: { pid: "$providerId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$to", "$$pid"] } } },
            { $group: { _id: "$to", avg: { $avg: "$rating" }, cnt: { $sum: 1 } } }
          ],
          as: "aggRating"
        }
      },
      { $unwind: { path: "$aggRating", preserveNullAndEmptyArrays: true } },
      // zwracamy z denormalizacją
      {
        $project: {
          orderId: 1,
          providerId: 1,
          // MVP Fields (nowe)
          price: 1,
          notes: 1,
          etaMinutes: 1,
          priceInfo: 1,
          contactMethod: 1,
          hasGuarantee: 1,
          guaranteeDetails: 1,
          // Legacy fields (kompatybilność wsteczna)
          amount: { $ifNull: ["$amount", "$price"] }, // Fallback do price jeśli brak amount
          message: { $ifNull: ["$message", "$notes"] }, // Fallback do notes jeśli brak message
          completionDate: 1,
          boostUntil: 1,
          boostFee: 1,
          createdAt: 1,
          sentAt: 1,
          expiresAt: 1,
          status: 1,
          pricing: 1,
          providerMeta: {
            name: { $ifNull: ["$provider.name", "$provider.displayName"] },
            avatar: "$provider.avatar",
            badges: "$provider.badges",
            level: { $ifNull: ["$provider.providerLevel", "standard"] },
            ratingAvg: { $round: ["$aggRating.avg", 2] },
            ratingCount: { $ifNull: ["$aggRating.cnt", 0] },
          },
        }
      },
      { $sort: { createdAt: -1 } },
    ]);

    res.json({ offers: items });
  } catch (e) {
    logger.error("GET_ORDER_OFFERS_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.query?.orderId
    });
    res.status(500).json({ message: "Błąd pobierania ofert" });
  }
});

// Akceptacja oferty przez klienta – bez requireKycVerified (KYC wymagane dla wykonawcy przy start/complete)
router.post("/:id/accept", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      paymentMethod = 'system', 
      includeGuarantee = true, 
      requestInvoice = false,
      totalAmount, 
      breakdown,
      // Teleporada - dane konsultacji
      scheduledDateTime,
      consultationType, // 'video' lub 'phone'
      consultationDuration
    } = req.body;

    const offer = await Offer.findById(id).populate('orderId');
    if (!offer) return res.status(404).json({ message: "Oferta nie istnieje" });

    const order = offer.orderId;
    if (!order) return res.status(404).json({ message: "Powiązane zlecenie nie istnieje" });

    // Sprawdź uprawnienia: tylko właściciel order może zaakceptować
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: "Tylko właściciel zlecenia może zaakceptować ofertę" });
    }
    
    // Sprawdź czy order nie ma już accepted offer
    if (order.acceptedOfferId) {
      return res.status(400).json({ message: "Zlecenie ma już zaakceptowaną ofertę" });
    }
    
    // Sprawdź czy oferta nie wygasła
    if (offer.expiresAt && offer.expiresAt < new Date()) {
      offer.status = 'expired';
      await offer.save();
      return res.status(400).json({ message: "Oferta wygasła" });
    }

    // Akceptuj ofertę
    offer.status = "accepted";
    offer.acceptedAt = new Date();
    await offer.save();

    // Odrzuć pozostałe oferty dla tego zlecenia
    const rejectedOffers = await Offer.find({ 
      orderId: order._id, 
      _id: { $ne: offer._id },
      status: { $ne: 'rejected' } // Nie aktualizuj już odrzuconych
    });
    
    await Offer.updateMany(
      { orderId: order._id, _id: { $ne: offer._id } },
      { 
        $set: { 
          status: "rejected",
          rejectedAt: new Date()
        } 
      }
    );
    
    // Wyślij powiadomienia do odrzuconych providerów
    const { notifyOfferRejected } = require("../utils/notifier");
    for (const rejectedOffer of rejectedOffers) {
      await notifyOfferRejected({ 
        app: req.app, 
        orderId: order._id, 
        offerId: rejectedOffer._id,
        providerId: rejectedOffer.providerId
      });
    }

    // Oblicz opłaty (bazując na aktualnej subskrypcji klienta, a nie danych z frontu)
    const baseAmount = offer.amount;
    
    // Subskrypcja klienta (pakiet PRO może mieć 0% prowizji od tej transakcji)
    const UserSubscription = require('../models/UserSubscription');
    const activeSubscription = await UserSubscription.findOne({
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    const clientPlanKey = activeSubscription?.planKey || null;
    const zeroCommissionPlans = ['CLIENT_PRO']; // Plany z 0% prowizji od tej opłaty
    const platformFeePercent = zeroCommissionPlans.includes(clientPlanKey) ? 0 : 5;
    const platformFee = Math.round(baseAmount * (platformFeePercent / 100));
    
    const guaranteeFee = (paymentMethod === 'system' && includeGuarantee)
      ? Math.round(baseAmount * 0.07)
      : 0;
    
    const total = baseAmount + platformFee + guaranteeFee;

    // Kwoty w groszach (Stripe / create-intent) — bez tego amountTotal zostaje 0 i płatność kończy się 500
    order.amountTotal = Math.round(Number(total) * 100);
    order.platformFeeAmount = Math.round(Number(platformFee) * 100);

    // Zaktualizuj zlecenie: przypisz wykonawcę, ustaw status i finalną cenę
    order.provider = offer.providerId;
    order.status = "accepted"; // MVP status
    
    // paymentPreference (system vs external) jest już ustawione przy tworzeniu zlecenia; paymentMethod w Order to enum ['card','p24','blik','unknown'] – nie nadpisywać

    order.acceptedOfferId = offer._id;
    order.requestInvoice = requestInvoice;
    
    // Ustaw ceny i opłaty
    order.pricing = {
      baseAmount,
      guaranteeFee,
      platformFee,
      total,
      currency: 'PLN',
      includeGuarantee: includeGuarantee && paymentMethod === 'system'
    };
    
    // Ustaw gwarancję
    order.protectionEligible = includeGuarantee && paymentMethod === 'system';
    order.protectionStatus = includeGuarantee && paymentMethod === 'system' ? 'active' : 'inactive';
    
    // Sprawdź czy to teleporada (na podstawie kategorii usługi)
    const isTeleconsultation = order.service && (
      order.service.toLowerCase().includes('teleporada') || 
      order.service.toLowerCase().includes('teleconsultation') ||
      order.service.toLowerCase().includes('konsultacja')
    );
    
    // Ustaw pola teleporady jeśli są podane
    if (isTeleconsultation || scheduledDateTime) {
      order.isTeleconsultation = true;
      if (scheduledDateTime) {
        order.scheduledDateTime = new Date(scheduledDateTime);
      }
      if (consultationType && ['video', 'phone', 'chat', 'email'].includes(consultationType)) {
        order.consultationType = consultationType;
      }
      if (consultationDuration) {
        order.consultationDuration = parseInt(consultationDuration) || 30;
      }
      
      // Generuj link do połączenia video (jeśli video)
      if (consultationType === 'video' && order.scheduledDateTime) {
        // TODO: Integracja z systemem video (np. Twilio, Jitsi, Zoom API)
        // Na razie generujemy placeholder link
        order.consultationLink = `/consultation/${order._id}/${offer._id}`;
      }
      
      // Jeśli phone, provider może podać numer w ofercie lub użyć domyślnego
      if (consultationType === 'phone') {
        // Provider może podać numer w offer.notes lub użyć numeru z profilu
        // Na razie zostawiamy null - będzie ustawiony później lub z profilu providera
        order.consultationPhone = null; // Można dodać logikę pobierania z profilu providera
      }
      
      // Jeśli email, skonfiguruj konsultację przez email
      if (consultationType === 'email') {
        // Konsultacja przez email - użytkownicy będą komunikować się przez system email
        // Chat jest już zintegrowany w OrderDetails, więc email będzie alternatywą
        // W przyszłości można dodać dedykowany system email communication
      }
      
      // Jeśli chat, konsultacja odbywa się przez istniejący system chat (ChatBox w OrderDetails)
      // Chat jest już zintegrowany, więc nie wymaga dodatkowej konfiguracji
    }
    
    await order.save();

    // Automatyczne tworzenie sesji wideo dla usług remote
    try {
      const Service = require('../models/Service');
      // Sprawdź czy usługa jest typu 'remote'
      let serviceData = null;
      if (order.service) {
        // order.service może być stringiem (kod usługi) lub ObjectId
        if (typeof order.service === 'string') {
          serviceData = await Service.findOne({ slug: order.service }).lean();
        } else {
          serviceData = await Service.findById(order.service).lean();
        }
      }
      
      // Jeśli usługa jest typu 'remote' lub 'hybrid', utwórz sesję wideo
      if (serviceData && (serviceData.service_kind === 'remote' || serviceData.service_kind === 'hybrid')) {
        const { createRoom, createToken, isConfigured } = require('../services/dailyService');
        const VideoSession = require('../models/VideoSession');
        
        if (isConfigured) {
          // Utwórz pokój w Daily.co
          const scheduledAt = order.scheduledDateTime || new Date(Date.now() + 24 * 60 * 60 * 1000); // Domyślnie za 24h
          const room = await createRoom({
            privacy: 'private',
            properties: {
              enable_screenshare: true,
              enable_chat: true,
              enable_knocking: false,
              enable_recording: false,
              exp: Math.floor(new Date(scheduledAt).getTime() / 1000) + (2 * 60 * 60) // 2h po rozpoczęciu
            }
          });

          // Pobierz dane klienta i providera
          const client = await require('../models/User').findById(order.client).lean();
          const provider = await require('../models/User').findById(offer.providerId).lean();

          // Utwórz tokeny dla uczestników
          const clientToken = await createToken(room.name, {
            userId: String(order.client),
            userName: client?.name || client?.email || 'Klient',
            isOwner: true
          });

          const providerToken = await createToken(room.name, {
            userId: String(offer.providerId),
            userName: provider?.name || provider?.email || 'Wykonawca',
            isOwner: false
          });

          // Zapisz sesję wideo w bazie
          const videoSession = await VideoSession.create({
            client: order.client,
            provider: offer.providerId,
            order: order._id,
            dailyRoomId: room.id,
            dailyRoomName: room.name,
            dailyRoomUrl: room.url,
            clientToken,
            providerToken,
            scheduledAt: scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt),
            price: offer.amount ? Math.round(offer.amount * 100) : 0, // Konwersja na grosze
            paid: false, // Płatność będzie zrealizowana później (jeśli przez system)
            status: 'scheduled'
          });

          // Powiąż sesję wideo ze zleceniem
          order.videoSession = videoSession._id;
          await order.save();

          logger.info(`✅ Automatycznie utworzono sesję wideo dla zlecenia ${order._id} (usługa remote)`);

          // Wyślij powiadomienia o utworzeniu sesji wideo
          try {
            const { sendPushToUser } = require('../utils/push');
            const Notification = require('../models/Notification');
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            const orderLink = `${frontendUrl}/orders/${order._id}`;
            const scheduledAtFormatted = new Date(scheduledAt).toLocaleString('pl-PL', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            });

            // Powiadomienie dla klienta
            await Notification.create({
              user: order.client,
              type: 'new_order', // Użyj istniejącego typu lub dodaj nowy 'video_session_created'
              title: 'Sesja wideo została utworzona',
              message: `Sesja wideo została zaplanowana na ${scheduledAtFormatted}`,
              link: orderLink,
              metadata: {
                orderId: order._id.toString(),
                videoSessionId: videoSession._id.toString(),
                scheduledAt: scheduledAt
              }
            });

            try {
              await sendPushToUser(order.client, {
                title: 'Sesja wideo utworzona',
                message: `Sesja wideo zaplanowana na ${scheduledAtFormatted}`,
                url: orderLink
              });
            } catch (pushError) {
              logger.warn('Błąd push notification dla klienta:', pushError.message);
            }

            // Powiadomienie dla providera
            await Notification.create({
              user: offer.providerId,
              type: 'new_order',
              title: 'Sesja wideo została utworzona',
              message: `Sesja wideo została zaplanowana na ${scheduledAtFormatted}`,
              link: orderLink,
              metadata: {
                orderId: order._id.toString(),
                videoSessionId: videoSession._id.toString(),
                scheduledAt: scheduledAt
              }
            });

            try {
              await sendPushToUser(offer.providerId, {
                title: 'Sesja wideo utworzona',
                message: `Sesja wideo zaplanowana na ${scheduledAtFormatted}`,
                url: orderLink
              });
            } catch (pushError) {
              logger.warn('Błąd push notification dla providera:', pushError.message);
            }
          } catch (notifyError) {
            logger.warn('Błąd wysyłania powiadomień o sesji wideo:', notifyError.message);
          }
        } else {
          logger.warn(`⚠️ Nie można utworzyć sesji wideo - Daily.co nie jest skonfigurowane`);
        }
      }
    } catch (videoError) {
      // Nie blokuj akceptacji oferty jeśli tworzenie sesji wideo się nie powiodło
      logger.error('Błąd automatycznego tworzenia sesji wideo:', {
        error: videoError.message,
        stack: videoError.stack,
        orderId: order._id
      });
    }

    // powiadom klientów o akceptacji oferty
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${order._id}`).emit("offer:accepted", {
        orderId: String(order._id),
        offerId: String(offer._id),
        providerId: String(offer.providerId),
        amount: offer.amount,
      });
    }

    // Wyślij powiadomienia email + push
    await notifyOfferAccepted({ app: req.app, orderId: order._id, offerId: offer._id });

    res.json({ 
      ok: true, 
      orderId: order._id, 
      offerId: offer._id,
      paymentMethod,
      includeGuarantee,
      totalAmount,
      breakdown: order.pricing
    });
  } catch (e) {
    logger.error("ACCEPT_OFFER_ERROR:", {
      message: e.message,
      stack: e.stack,
      offerId: req.params?.id,
      userId: req.user?._id
    });
    res.status(500).json({ message: "Błąd akceptacji oferty" });
  }
});

// PATCH /api/offers/:id - edycja oferty przez providera (tylko status sent/submitted)
router.patch("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const offer = await Offer.findById(id);
    if (!offer) return res.status(404).json({ message: "Oferta nie istnieje" });
    if (String(offer.providerId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Brak uprawnień do edycji tej oferty" });
    }
    const allowedStatuses = ["sent", "submitted"];
    if (!allowedStatuses.includes(offer.status)) {
      return res.status(400).json({
        message: `Nie można edytować oferty ze statusem: ${offer.status}. Można edytować tylko oferty oczekujące.`
      });
    }
    const order = await Order.findById(offer.orderId);
    if (order && order.status === "accepted" && String(order.acceptedOfferId) === String(offer._id)) {
      return res.status(400).json({ message: "Nie można edytować zaakceptowanej oferty" });
    }

    const { amount, price, message, notes, completionDate, paymentMethod } = req.body;
    if (typeof amount !== "undefined" || typeof price !== "undefined") {
      const val = amount !== undefined ? Number(amount) : Number(price);
      if (!Number.isFinite(val) || val < 0) return res.status(400).json({ message: "Nieprawidłowa kwota" });
      offer.price = val;
      offer.amount = val;
    }
    if (typeof message !== "undefined") { offer.notes = message; offer.message = message; }
    if (typeof notes !== "undefined") { offer.notes = notes; offer.message = notes; }
    if (typeof completionDate !== "undefined") {
      offer.completionDate = completionDate ? new Date(completionDate) : null;
    }
    if (typeof paymentMethod !== "undefined" && ["system", "external"].includes(paymentMethod)) {
      offer.paymentMethod = paymentMethod;
    }

    await offer.save();
    res.json({ message: "Oferta zaktualizowana", offer });
  } catch (e) {
    logger.error("PATCH_OFFER_ERROR:", { message: e.message, offerId: req.params?.id });
    res.status(500).json({ message: "Błąd aktualizacji oferty" });
  }
});

// DELETE /api/offers/:id - anulowanie oferty przez providera
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const offer = await Offer.findById(id);
    
    if (!offer) {
      return res.status(404).json({ message: "Oferta nie istnieje" });
    }
    
    // Sprawdź czy to oferta tego providera
    if (String(offer.providerId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Brak uprawnień do anulowania tej oferty" });
    }
    
    // Sprawdź czy oferta może być anulowana (tylko jeśli status = "submitted" lub "sent")
    if (offer.status !== "submitted" && offer.status !== "sent") {
      return res.status(400).json({ 
        message: `Nie można anulować oferty ze statusem: ${offer.status}. Można anulować tylko oferty oczekujące.` 
      });
    }
    
    // Sprawdź czy zlecenie nie zostało już zaakceptowane
    const order = await Order.findById(offer.orderId);
    if (order && order.status === "accepted" && String(order.acceptedOfferId) === String(offer._id)) {
      return res.status(400).json({ message: "Nie można anulować zaakceptowanej oferty" });
    }
    
    // Oznacz ofertę jako anulowaną
    offer.status = "withdrawn";
    await offer.save();
    
    // Powiadom klienta o anulowaniu oferty (opcjonalnie)
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${offer.orderId}`).emit("offer:withdrawn", {
        orderId: String(offer.orderId),
        offerId: String(offer._id),
        providerId: String(offer.providerId),
      });
    }
    
    res.json({ 
      message: "Oferta została anulowana",
      offer 
    });
  } catch (e) {
    logger.error("CANCEL_OFFER_ERROR:", {
      message: e.message,
      stack: e.stack,
      offerId: req.params?.id,
      providerId: req.user?._id
    });
    res.status(500).json({ message: "Błąd anulowania oferty" });
  }
});

module.exports = router;
