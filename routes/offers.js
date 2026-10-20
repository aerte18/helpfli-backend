const express = require("express");
const mongoose = require("mongoose");
const { randomUUID } = require('crypto');
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const { requireKycVerified } = require("../middleware/kyc");
const Offer = require("../models/Offer");
const Order = require("../models/Order");
const User = require("../models/User");
const UserSubscription = require('../models/UserSubscription');
const Revenue = require("../models/Revenue");
const { computePricingBands } = require("../utils/pricing");
const { notifyOfferNew, notifyOfferAccepted } = require("../utils/notifier");
const logger = require("../utils/logger");
const { evaluateOfferPreflight, normalizeOfferQuality } = require("../ai/utils/preflightQualityEvaluator");
const {
  AcceptanceValidationError,
  acceptedOfferProviderMatches,
  buildAcceptanceLockFilter,
  buildAcceptancePricing,
  buildOfferReservationFilter,
  buildOfferReservationRefresh,
  buildOfferReservationRelease,
  buildOfferReservationUpdate,
  contactUnlockIsSettled,
  offerAcceptanceReservationIsStale,
  resolveAcceptancePaymentFlow,
} = require('../utils/offerAcceptance');
const { computeOrderPlatformFee } = require('../utils/foundingProvider');

/** Poniżej progu: wysyłka wymaga potwierdzenia „Wyślij mimo to” (tak samo weryfikowane na serwerze). */
const OFFER_AI_HARD_THRESHOLD = 45;
const ENABLE_STRIPE_CONNECT = process.env.ENABLE_STRIPE_CONNECT === 'true';

async function getAcceptanceQuote({ order, offer, userId, paymentMethod, includeGuarantee }) {
  const isOffersOnlyOrder = order.orderMode === 'offers_only';
  const effectivePaymentFlow = resolveAcceptancePaymentFlow({
    orderPreference: order.paymentPreference,
    requestedPaymentMethod: paymentMethod,
    isOffersOnlyOrder,
  });

  const [activeSubscription, providerUser] = await Promise.all([
    UserSubscription.findOne({ user: userId, validUntil: { $gt: new Date() } }),
    User.findById(offer.providerId).select(
      'foundingProvider foundingProviderExpiresAt commissionDiscountPercent foundingProviderActivatedAt stripeAccountId stripeConnectStatus isB2B b2b'
    ),
  ]);

  if (!providerUser) {
    throw new AcceptanceValidationError('Wykonawca nie istnieje.', 'PROVIDER_NOT_FOUND', 404);
  }

  if (effectivePaymentFlow === 'system') {
    if (!ENABLE_STRIPE_CONNECT) {
      throw new AcceptanceValidationError(
        'Płatności przez Helpfli są tymczasowo niedostępne. Wybierz płatność poza serwisem.',
        'SYSTEM_PAYMENTS_DISABLED',
        503
      );
    }
    if (
      !providerUser.stripeAccountId ||
      !providerUser.stripeConnectStatus?.chargesEnabled ||
      !providerUser.stripeConnectStatus?.payoutsEnabled
    ) {
      throw new AcceptanceValidationError(
        'Ten wykonawca nie ma jeszcze w pełni aktywnych płatności i wypłat Stripe. Wybierz płatność poza systemem.',
        'PROVIDER_PAYOUTS_UNAVAILABLE',
        409
      );
    }
  }

  const baseAmount = Number(offer.amount ?? offer.price);
  const clientPlanKey = activeSubscription?.planKey || null;
  const feeCalc = computeOrderPlatformFee({
    baseAmount,
    clientPlanKey,
    providerUser,
    defaultPercent: 5,
    offersOnly: isOffersOnlyOrder,
  });
  const pricing = buildAcceptancePricing({
    baseAmount,
    platformFee: feeCalc.platformFee,
    platformFeeBeforeDiscount: feeCalc.platformFeeBeforeDiscount,
    platformFeePercent: feeCalc.platformFeePercent,
    foundingDiscountApplied: feeCalc.foundingDiscountApplied,
    feeExplanation: feeCalc.feeExplanation,
    paymentFlow: effectivePaymentFlow,
    includeGuarantee,
  });
  const commissionChargedPln =
    effectivePaymentFlow === 'external' && pricing.platformFee > 0
      ? Math.max(pricing.platformFee, 2)
      : 0;
  pricing.commissionChargedPln = commissionChargedPln;

  return {
    activeSubscription,
    clientPlanKey,
    effectivePaymentFlow,
    feeCalc,
    isOffersOnlyOrder,
    pricing,
    paymentDueNow: effectivePaymentFlow === 'external' ? commissionChargedPln : pricing.total,
    providerUser,
  };
}

function sendAcceptanceError(res, error) {
  if (error instanceof AcceptanceValidationError) {
    return res.status(error.status || 400).json({ message: error.message, code: error.code });
  }
  throw error;
}

async function releaseOfferAcceptanceReservation({
  offerId,
  token,
  status = 'sent',
  expectedReservedAt,
}) {
  if (!offerId || !token) return;
  const transition = buildOfferReservationRelease({
    offerId,
    token,
    status,
    expectedReservedAt,
  });
  return Offer.updateOne(transition.filter, transition.update);
}

async function reconcileAcceptedOfferStatuses(
  orderId,
  acceptedOfferId,
  { acceptanceToken = null, allowRepair = false } = {}
) {
  const rejectedOffers = await Offer.find({
    orderId,
    _id: { $ne: acceptedOfferId },
    status: { $in: ['sent', 'accepting'] },
  }).select('_id providerId');

  const acceptedAt = new Date();
  const acceptedStates = [{ status: 'accepted' }];
  if (acceptanceToken) {
    acceptedStates.push({ status: 'accepting', acceptanceToken });
  }
  if (allowRepair) {
    acceptedStates.push({ status: 'sent' }, { status: 'accepting' });
  }
  const acceptedResult = await Offer.updateOne(
    { _id: acceptedOfferId, orderId, $or: acceptedStates },
    {
      $set: { status: 'accepted', acceptedAt },
      $unset: {
        rejectedAt: 1,
        acceptanceToken: 1,
        acceptanceReservedBy: 1,
        acceptanceReservedAt: 1,
      },
    }
  );
  if (!(acceptedResult.matchedCount ?? acceptedResult.n)) {
    throw new Error('Accepted offer could not be reconciled');
  }

  await Offer.updateMany(
    { orderId, _id: { $ne: acceptedOfferId }, status: { $in: ['sent', 'accepting'] } },
    {
      $set: { status: 'rejected', rejectedAt: acceptedAt },
      $unset: {
        acceptanceToken: 1,
        acceptanceReservedBy: 1,
        acceptanceReservedAt: 1,
      },
    }
  );

  return rejectedOffers;
}

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
  if (!aiQuality || typeof aiQuality !== "object") return undefined;
  const base = normalizeOfferQuality(aiQuality);
  if (!base) return undefined;
  if (aiQuality.lowQualityOverride === true) {
    base.lowQualityOverride = true;
    const th = Number(aiQuality.qualityGateThreshold);
    if (Number.isFinite(th) && th >= 0 && th <= 100) {
      base.qualityGateThreshold = th;
    } else {
      base.qualityGateThreshold = OFFER_AI_HARD_THRESHOLD;
    }
    const scoreAtOverride = Number(aiQuality.scoreAtOverride);
    if (Number.isFinite(scoreAtOverride) && scoreAtOverride >= 0 && scoreAtOverride <= 100) {
      base.scoreAtOverride = Math.round(scoreAtOverride);
    } else if (Number.isFinite(Number(base.percent))) {
      base.scoreAtOverride = Number(base.percent);
    }
    const overrideAt = aiQuality.lowQualityOverrideAt ? new Date(aiQuality.lowQualityOverrideAt) : new Date();
    base.lowQualityOverrideAt = Number.isNaN(overrideAt.getTime()) ? new Date() : overrideAt;
  }
  return base;
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
    
    const provider = await User.findById(req.user._id);
    if (!provider) return res.status(404).json({ message: "Provider nie istnieje" });

    const orderForSlots = await Order.findById(orderId).select('orderMode service').lean();
    if (!orderForSlots) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const UserSubscription = require('../models/UserSubscription');
    const providerSub = await UserSubscription.findOne({
      user: req.user._id,
      validUntil: { $gt: new Date() },
    }).lean();
    const providerPlanKey = providerSub?.planKey || 'PROV_FREE';

    const { resolveOfferSlotCost } = require('../utils/offersOnlyMonetization');
    const slotInfo = await resolveOfferSlotCost({
      order: orderForSlots,
      serviceSlug: orderForSlots.service,
      providerPlanKey,
    });
    const slotCost = slotInfo.slots || 1;

    const { getProviderOffersLimit, isUnlimitedLimit } = require('../utils/syncProviderSubscriptionLimits');
    const offersLimit = await getProviderOffersLimit(provider._id, provider);
    if (provider.monthlyOffersLimit !== offersLimit) {
      provider.monthlyOffersLimit = offersLimit;
    }

    // Sprawdź limity ofert miesięcznie (duży projekt może kosztować 2–3 sloty)
    if (
      !isUnlimitedLimit(offersLimit) &&
      provider.monthlyOffersUsed + slotCost > offersLimit
    ) {
      // Utwórz powiadomienie zamiast zwracania błędu
      const Notification = require('../models/Notification');
      const remaining = offersLimit - provider.monthlyOffersUsed;
      
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
          message: `Wykorzystałeś wszystkie oferty w tym miesiącu (${offersLimit}). Ulepsz pakiet aby zwiększyć limit.`,
          link: '/account/subscriptions',
          metadata: {
            limit: offersLimit,
            used: provider.monthlyOffersUsed,
            providerTier: provider.providerTier || 'basic',
            upsell: suggestion
          }
        });
      }

      return res.status(403).json({
        message:
          slotCost > 1
            ? `Ta oferta wymaga ${slotCost} slotów w pakiecie (duży projekt). Wykorzystałeś limit ${offersLimit} odpowiedzi w tym miesiącu.`
            : `Przekroczono limit ofert miesięcznie (${offersLimit}). Sprawdź powiadomienia aby zobaczyć szczegóły.`,
        code: 'offer_limit_exceeded',
        slotCost,
        slotsUsed: provider.monthlyOffersUsed,
        slotsLimit: offersLimit,
      });
    }

    // Sprawdź czy limit jest niski (mniej niż 20% pozostało) i wyślij ostrzeżenie
    if (!isUnlimitedLimit(offersLimit)) {
    const remaining = offersLimit - provider.monthlyOffersUsed - slotCost;
    const warningThreshold = Math.max(1, Math.floor(offersLimit * 0.2));

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
          message: `Zostało Ci ${remaining} z ${offersLimit} ofert w tym miesiącu. Rozważ ulepszenie pakietu.`,
          link: '/account/subscriptions',
          metadata: {
            limit: offersLimit,
            used: provider.monthlyOffersUsed,
            remaining: remaining
          }
        });
      }
    }
    }

    await provider.save();

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const OFFERABLE_STATUSES = ['open', 'collecting_offers', 'pending'];
    if (!OFFERABLE_STATUSES.includes(order.status)) {
      return res.status(400).json({
        message: 'Na to zlecenie nie można już składać ofert',
        code: 'order_not_open_for_offers',
        orderStatus: order.status
      });
    }
    if (order.acceptedOfferId) {
      return res.status(400).json({
        message: 'Zlecenie ma już zaakceptowaną ofertę',
        code: 'order_already_accepted'
      });
    }

    const existingOffer = await Offer.findOne({
      orderId,
      providerId: req.user._id,
      status: { $in: ['sent', 'accepting'] }
    }).select('_id');
    if (existingOffer) {
      return res.status(409).json({
        message: 'Masz już aktywną ofertę na to zlecenie',
        code: 'duplicate_offer',
        offerId: existingOffer._id
      });
    }

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

    const orderContext = {
      service: typeof order.service === "object" ? order.service?.code : order.service,
      description: order.description || "",
      urgency: order.urgency || "normal",
      location: order.location?.city || order.location?.address || "",
      budget: order.budget || order.budgetRange || null
    };
    const priceInfoBody = req.body.priceInfo || { includes: [], isFinal: true };
    const offerDraft = {
      amount: Number(finalPrice),
      message: String(finalNotes || ""),
      completionDate: finalCompletionDate,
      priceIncludes: Array.isArray(priceInfoBody.includes) ? priceInfoBody.includes : [],
      isFinalPrice: priceInfoBody.isFinal !== false,
      contactMethod: String(req.body.contactMethod || ""),
      providerLevel: provider.providerLevel || provider.providerTier || "standard"
    };
    const qualityForStore = await evaluateOfferPreflight({ orderContext, offerDraft });
    const serverPct = qualityForStore?.percent || 0;
    const clientOverride = Boolean(aiQuality?.lowQualityOverride);
    if (serverPct > 0 && serverPct < OFFER_AI_HARD_THRESHOLD && !clientOverride) {
      return res.status(400).json({
        message:
          "Jakość oferty jest poniżej wymaganego progu. Uzupełnij treść oferty albo wybierz „Wyślij mimo to”.",
        code: "offer_quality_too_low",
        quality: qualityForStore
      });
    }
    const withOverride = Boolean(clientOverride && serverPct < OFFER_AI_HARD_THRESHOLD);
    const normalizedAiQuality = normalizeOfferAiQuality({
      ...qualityForStore,
      lowQualityOverride: withOverride,
      qualityGateThreshold: OFFER_AI_HARD_THRESHOLD,
      ...(withOverride
        ? {
            scoreAtOverride: serverPct,
            lowQualityOverrideAt: new Date().toISOString()
          }
        : {})
    });
    
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
      issuesInvoice: !!(provider.isB2B || provider.b2b),
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

    // Zwiększ licznik ofert miesięcznie (duży projekt = więcej slotów)
    provider.monthlyOffersUsed += slotCost;
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
      pricingAdvice,
      slotCost,
      slotsRemaining: Math.max(0, provider.monthlyOffersLimit - provider.monthlyOffersUsed),
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
    
    const providerUser = await User.findById(req.user._id).select('freeBoostsRemaining foundingProvider foundingProviderExpiresAt');
    const { isFoundingProviderActive } = require('../utils/foundingProvider');
    if (providerUser && isFoundingProviderActive(providerUser) && (providerUser.freeBoostsRemaining || 0) > 0) {
      providerUser.freeBoostsRemaining -= 1;
      await providerUser.save();
      boostsRemaining = providerUser.freeBoostsRemaining;
      offer.highlighted = true;
      offer.highlightedUntil = highlightedUntil;
      offer.boostedAt = new Date();
      offer.boostFree = true;
      await offer.save();
      return res.json({
        message: `Oferta wyróżniona (Pierwszy wykonawca — darmowo) • Pozostało ${boostsRemaining} wyróżnień`,
        offer,
        highlightedUntil: offer.highlightedUntil,
        requiresPayment: false,
        boostsRemaining,
        source: 'founding_provider',
      });
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

    const order = await Order.findById(orderId).select("client provider").lean();
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const { getOrderPartyAccess, companyTeamHasOrderProvider } = require("../utils/orderAccess");
    const access = await getOrderPartyAccess(order, req.user);
    const isCompanyViewer =
      req.user.company &&
      order.provider &&
      (await companyTeamHasOrderProvider(req.user.company, order.provider));

    if (!access.isClient && access.side !== "admin" && !isCompanyViewer) {
      return res.status(403).json({ message: "Brak dostępu do ofert tego zlecenia" });
    }

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
          issuesInvoice: 1,
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
            foundingProvider: "$provider.foundingProvider",
            foundingProviderExpiresAt: "$provider.foundingProviderExpiresAt",
            commissionDiscountPercent: "$provider.commissionDiscountPercent",
            isB2B: "$provider.isB2B",
            b2b: "$provider.b2b",
            stripeChargesEnabled: { $ifNull: ["$provider.stripeConnectStatus.chargesEnabled", false] },
            stripePayoutsEnabled: { $ifNull: ["$provider.stripeConnectStatus.payoutsEnabled", false] },
            stripeAccountConfigured: {
              $gt: [
                { $strLenCP: { $ifNull: ["$provider.stripeAccountId", ""] } },
                0,
              ],
            },
          },
        }
      },
      { $sort: { createdAt: -1 } },
    ]);

    const { isFoundingProviderActive, getFoundingCommissionDiscountPercent } = require('../utils/foundingProvider');
    const enriched = items.map((o) => {
      const p = o.providerMeta || {};
      const foundingActive = isFoundingProviderActive(p);
      const issuesInvoice = !!(o.issuesInvoice || p?.isB2B || p?.b2b);
      return {
        ...o,
        issuesInvoice,
        providerMeta: {
          ...(o.providerMeta || {}),
          issuesInvoice,
          foundingProviderActive: !!foundingActive,
          foundingCommissionWaived: foundingActive && getFoundingCommissionDiscountPercent(p) >= 100,
          foundingExpiresAt: foundingActive ? p.foundingProviderExpiresAt : null,
          systemPaymentAvailable: Boolean(
            ENABLE_STRIPE_CONNECT &&
            p.stripeAccountConfigured &&
            p.stripeChargesEnabled &&
            p.stripePayoutsEnabled
          ),
          systemPaymentUnavailableReason: !ENABLE_STRIPE_CONNECT
            ? 'Płatności przez Helpfli są tymczasowo niedostępne. Wybierz płatność poza serwisem.'
            : (!p.stripeAccountConfigured || !p.stripeChargesEnabled || !p.stripePayoutsEnabled)
              ? 'Ten wykonawca nie ma jeszcze w pełni aktywnych płatności i wypłat Stripe.'
              : null,
        },
      };
    });

    res.json({ offers: enriched });
  } catch (e) {
    logger.error("GET_ORDER_OFFERS_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.query?.orderId
    });
    res.status(500).json({ message: "Błąd pobierania ofert" });
  }
});

// Serwer jest jedynym źródłem prawdy dla ceny widocznej przed akceptacją.
router.post("/:id/acceptance-quote", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.id).populate('orderId');
    if (!offer) return res.status(404).json({ message: 'Oferta nie istnieje' });

    const order = offer.orderId;
    if (!order) return res.status(404).json({ message: 'Powiązane zlecenie nie istnieje' });
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko właściciel zlecenia może pobrać wycenę' });
    }
    if (order.acceptedOfferId && String(order.acceptedOfferId) !== String(offer._id)) {
      return res.status(409).json({ message: 'Zlecenie ma już zaakceptowaną ofertę' });
    }
    if (offer.expiresAt && offer.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Oferta wygasła', code: 'OFFER_EXPIRED' });
    }
    if (!['sent', 'accepted'].includes(offer.status)) {
      return res.status(409).json({ message: 'Ta oferta nie jest już dostępna', code: 'OFFER_NOT_AVAILABLE' });
    }

    let quote;
    try {
      quote = await getAcceptanceQuote({
        order,
        offer,
        userId: req.user._id,
        paymentMethod: req.body?.paymentMethod,
        includeGuarantee: req.body?.includeGuarantee === true,
      });
    } catch (error) {
      return sendAcceptanceError(res, error);
    }

    return res.json({
      offerId: offer._id,
      orderId: order._id,
      paymentMethod: quote.effectivePaymentFlow,
      pricing: quote.pricing,
      paymentDueNow: quote.paymentDueNow,
      amountTotal: Math.round(quote.pricing.total * 100),
      platformFeeAmount: Math.round(quote.pricing.platformFee * 100),
      protectionEligible: quote.pricing.includeGuarantee,
      clientPlanKey: quote.clientPlanKey,
      feeMeta: {
        platformFeePercent: quote.feeCalc.platformFeePercent,
        foundingDiscountApplied: quote.feeCalc.foundingDiscountApplied,
        platformFeeBeforeDiscount: quote.feeCalc.platformFeeBeforeDiscount,
        feeExplanation: quote.feeCalc.feeExplanation,
        foundingExpiresAt: quote.feeCalc.foundingExpiresAt,
      },
    });
  } catch (error) {
    logger.error('ACCEPTANCE_QUOTE_ERROR:', {
      message: error.message,
      stack: error.stack,
      offerId: req.params?.id,
      userId: req.user?._id,
    });
    return res.status(500).json({ message: 'Błąd przygotowania wyceny oferty' });
  }
});

// Akceptacja oferty przez klienta – bez requireKycVerified (KYC wymagane dla wykonawcy przy start/complete)
router.post("/:id/accept", auth, async (req, res) => {
  let acceptanceReservation = null;
  let orderClaimed = false;
  try {
    const { id } = req.params;
    const {
      paymentMethod,
      includeGuarantee = true, 
      requestInvoice = false,
      // Teleporada - dane konsultacji
      scheduledDateTime,
      consultationType, // 'video' lub 'phone'
      consultationDuration
    } = req.body;

    let offer = await Offer.findById(id).populate('orderId');
    if (!offer) return res.status(404).json({ message: "Oferta nie istnieje" });

    let order = offer.orderId;
    if (!order) return res.status(404).json({ message: "Powiązane zlecenie nie istnieje" });

    // Sprawdź uprawnienia: tylko właściciel order może zaakceptować
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: "Tylko właściciel zlecenia może zaakceptować ofertę" });
    }
    
    // Retry po zdobyciu atomowego locka Order może bezpiecznie dokończyć wyłącznie
    // tę samą ofertę i tego samego wykonawcę. Nie wskrzeszamy ofert wycofanych ani wygasłych.
    if (order.acceptedOfferId) {
      if (String(order.acceptedOfferId) === String(offer._id) && order.status === "accepted") {
        if (!acceptedOfferProviderMatches(order, offer)) {
          return res.status(409).json({
            message: 'Zaakceptowana oferta nie zgadza się z przypisanym wykonawcą.',
            code: 'ACCEPTED_PROVIDER_MISMATCH',
          });
        }
        if (!['sent', 'accepting', 'accepted'].includes(offer.status)) {
          return res.status(409).json({
            message: 'Nie można dokończyć akceptacji wycofanej lub wygasłej oferty.',
            code: 'OFFER_FINALIZATION_CONFLICT',
          });
        }
        await reconcileAcceptedOfferStatuses(order._id, offer._id, { allowRepair: true });
        return res.json({
          ok: true,
          orderId: order._id,
          offerId: offer._id,
          orderMode: order.orderMode || 'standard',
          paymentMethod: order.paymentPreference || paymentMethod,
          includeGuarantee: !!order.protectionEligible,
          totalAmount: order.pricing?.total ?? offer.amount,
          breakdown: order.pricing,
          alreadyAccepted: true,
        });
      }
      return res.status(409).json({ message: "Zlecenie ma już zaakceptowaną ofertę", code: 'ORDER_ALREADY_ACCEPTED' });
    }

    if (offer.status === 'accepting') {
      if (offerAcceptanceReservationIsStale(offer) && offer.acceptanceToken) {
        await releaseOfferAcceptanceReservation({
          offerId: offer._id,
          token: offer.acceptanceToken,
          expectedReservedAt: offer.acceptanceReservedAt,
        });
        offer = await Offer.findById(id).populate('orderId');
        order = offer?.orderId;
      }
      if (!offer || offer.status === 'accepting') {
        return res.status(409).json({
          message: 'Akceptacja tej oferty jest już przetwarzana. Spróbuj ponownie za chwilę.',
          code: 'OFFER_ACCEPTANCE_IN_PROGRESS',
        });
      }
      if (!order) {
        return res.status(404).json({ message: 'Powiązane zlecenie nie istnieje' });
      }
      if (String(order.client) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Tylko właściciel zlecenia może zaakceptować ofertę' });
      }
    }

    const reservationTime = new Date();
    if (offer.expiresAt && new Date(offer.expiresAt) <= reservationTime) {
      await Offer.updateOne(
        { _id: offer._id, status: 'sent', expiresAt: { $lte: reservationTime } },
        {
          $set: { status: 'expired' },
          $unset: {
            acceptanceToken: 1,
            acceptanceReservedBy: 1,
            acceptanceReservedAt: 1,
          },
        }
      );
      return res.status(400).json({ message: "Oferta wygasła", code: 'OFFER_EXPIRED' });
    }
    if (offer.status !== 'sent') {
      return res.status(409).json({ message: 'Ta oferta nie jest już dostępna', code: 'OFFER_NOT_AVAILABLE' });
    }

    const acceptanceToken = randomUUID();
    const reservedOffer = await Offer.findOneAndUpdate(
      buildOfferReservationFilter({
        offerId: offer._id,
        orderId: order._id,
        now: reservationTime,
      }),
      buildOfferReservationUpdate({
        token: acceptanceToken,
        clientId: req.user._id,
        now: reservationTime,
      }),
      { new: true, runValidators: true }
    );

    if (!reservedOffer) {
      const [currentOffer, currentOrder] = await Promise.all([
        Offer.findById(id),
        Order.findById(order._id)
          .select('acceptedOfferId status provider paymentPreference protectionEligible pricing orderMode'),
      ]);
      if (
        currentOffer &&
        currentOrder &&
        String(currentOrder.acceptedOfferId || '') === String(currentOffer._id) &&
        currentOrder.status === 'accepted' &&
        acceptedOfferProviderMatches(currentOrder, currentOffer) &&
        ['sent', 'accepting', 'accepted'].includes(currentOffer.status)
      ) {
        await reconcileAcceptedOfferStatuses(currentOrder._id, currentOffer._id, { allowRepair: true });
        return res.json({
          ok: true,
          orderId: currentOrder._id,
          offerId: currentOffer._id,
          orderMode: currentOrder.orderMode || 'standard',
          paymentMethod: currentOrder.paymentPreference,
          includeGuarantee: !!currentOrder.protectionEligible,
          totalAmount: currentOrder.pricing?.total ?? currentOffer.amount,
          breakdown: currentOrder.pricing,
          alreadyAccepted: true,
        });
      }
      return res.status(409).json({
        message: 'Oferta została zmieniona, wycofana albo jej akceptacja jest już przetwarzana.',
        code: 'OFFER_ACCEPTANCE_CONFLICT',
      });
    }

    offer = reservedOffer;
    acceptanceReservation = { offerId: offer._id, token: acceptanceToken };

    // Pobieramy Order ponownie dopiero po rezerwacji. Wycena i zapis korzystają dzięki
    // temu z jednego, niezmiennego snapshotu oferty.
    order = await Order.findById(offer.orderId);
    if (!order) {
      await releaseOfferAcceptanceReservation(acceptanceReservation);
      acceptanceReservation = null;
      return res.status(404).json({ message: 'Powiązane zlecenie nie istnieje' });
    }
    if (String(order.client) !== String(req.user._id)) {
      await releaseOfferAcceptanceReservation(acceptanceReservation);
      acceptanceReservation = null;
      return res.status(403).json({ message: 'Tylko właściciel zlecenia może zaakceptować ofertę' });
    }
    if (order.acceptedOfferId) {
      const acceptedSameOffer = String(order.acceptedOfferId) === String(offer._id);
      if (acceptedSameOffer) {
        if (order.status === 'accepted' && acceptedOfferProviderMatches(order, offer)) {
          orderClaimed = true;
          await reconcileAcceptedOfferStatuses(order._id, offer._id, { acceptanceToken });
          acceptanceReservation = null;
          return res.json({
            ok: true,
            orderId: order._id,
            offerId: offer._id,
            orderMode: order.orderMode || 'standard',
            paymentMethod: order.paymentPreference,
            includeGuarantee: !!order.protectionEligible,
            totalAmount: order.pricing?.total ?? offer.amount,
            breakdown: order.pricing,
            alreadyAccepted: true,
          });
        }
        await releaseOfferAcceptanceReservation(acceptanceReservation);
        acceptanceReservation = null;
        return res.status(409).json({
          message: 'Zaakceptowana oferta nie zgadza się z przypisanym wykonawcą lub statusem zlecenia.',
          code: 'ACCEPTED_PROVIDER_MISMATCH',
        });
      }
      await releaseOfferAcceptanceReservation({ ...acceptanceReservation, status: 'rejected' });
      acceptanceReservation = null;
      return res.status(409).json({
        message: 'Zlecenie ma już zaakceptowaną ofertę.',
        code: 'ORDER_ALREADY_ACCEPTED',
      });
    }

    let quote;
    try {
      quote = await getAcceptanceQuote({
        order,
        offer,
        userId: req.user._id,
        paymentMethod,
        includeGuarantee: includeGuarantee === true,
      });
    } catch (error) {
      await releaseOfferAcceptanceReservation(acceptanceReservation);
      acceptanceReservation = null;
      return sendAcceptanceError(res, error);
    }

    const {
      clientPlanKey,
      effectivePaymentFlow,
      feeCalc,
      isOffersOnlyOrder,
      pricing,
    } = quote;
    const { baseAmount, platformFee, total } = pricing;
    const platformFeePercent = feeCalc.platformFeePercent;
    order.platformFeePercent = platformFeePercent;

    // Kwoty w groszach (Stripe / create-intent) — bez tego amountTotal zostaje 0 i płatność kończy się 500
    order.amountTotal = Math.round(Number(total) * 100);
    order.platformFeeAmount = Math.round(Number(platformFee) * 100);

    // Zaktualizuj zlecenie: przypisz wykonawcę, ustaw status i finalną cenę
    order.provider = offer.providerId;
    order.status = "accepted"; // MVP status
    
    // Persistuj wybrany flow płatności dla zaakceptowanej oferty.
    // paymentPreference steruje logiką system vs external.
    order.paymentPreference = effectivePaymentFlow;
    order.paymentStatus = 'unpaid';
    order.paidInSystem = false;
    order.externalCommissionStatus = 'unpaid';
    // paymentMethod w Order to enum ['card','p24','blik','unknown'] – nie nadpisywać tutaj

    order.acceptedOfferId = offer._id;
    order.acceptedAt = new Date();
    order.requestInvoice = requestInvoice;
    const {
      clientHasFreeContactUnlock,
      getContactUnlockFeePln,
    } = require('../utils/offersOnlyMonetization');

    let requiresContactUnlock = false;
    let contactUnlockFeePln = 0;
    let contactUnlockAlreadySettled = isOffersOnlyOrder && contactUnlockIsSettled(order);

    if (isOffersOnlyOrder) {
      if (contactUnlockAlreadySettled) {
        // Nie cofaj opłaconego/zwolnionego odblokowania przy późniejszej akceptacji oferty.
        contactUnlockFeePln = Number(order.contactUnlockFeePln) || 0;
      } else {
        const fee = getContactUnlockFeePln(clientPlanKey);
        if (clientHasFreeContactUnlock(clientPlanKey) || fee <= 0) {
          order.contactUnlockStatus = 'waived';
          order.contactUnlockFeePln = 0;
          order.contactUnlockedAt = new Date();
        } else {
          order.contactUnlockStatus = 'unpaid';
          order.contactUnlockFeePln = fee;
          order.contactUnlockedAt = null;
          requiresContactUnlock = true;
          contactUnlockFeePln = fee;
        }
      }
    }
    
    // Ustaw ceny i opłaty
    order.pricing = pricing;
    
    // Ustaw gwarancję
    order.protectionEligible = pricing.includeGuarantee;
    // Sam wybór ochrony nie oznacza jeszcze aktywnej ochrony. Status aktywuje
    // dopiero potwierdzona przez Stripe płatność/autoryzacja.
    order.protectionStatus = 'inactive';
    
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
    
    const orderSet = {
      provider: offer.providerId,
      status: 'accepted',
      paymentPreference: effectivePaymentFlow,
      paymentStatus: 'unpaid',
      paidInSystem: false,
      externalCommissionStatus: 'unpaid',
      acceptedOfferId: offer._id,
      acceptedAt: order.acceptedAt,
      requestInvoice: requestInvoice === true,
      amountTotal: order.amountTotal,
      platformFeeAmount: order.platformFeeAmount,
      platformFeePercent,
      pricing,
      protectionEligible: pricing.includeGuarantee,
      protectionStatus: 'inactive',
    };

    if (isOffersOnlyOrder && !contactUnlockAlreadySettled) {
      orderSet.contactUnlockStatus = order.contactUnlockStatus;
      orderSet.contactUnlockFeePln = order.contactUnlockFeePln;
      orderSet.contactUnlockedAt = order.contactUnlockedAt;
    }

    if (isTeleconsultation || scheduledDateTime) {
      orderSet.isTeleconsultation = true;
      if (order.scheduledDateTime) orderSet.scheduledDateTime = order.scheduledDateTime;
      if (order.consultationType) orderSet.consultationType = order.consultationType;
      if (order.consultationDuration) orderSet.consultationDuration = order.consultationDuration;
      if (order.consultationLink) orderSet.consultationLink = order.consultationLink;
      if (consultationType === 'phone') orderSet.consultationPhone = null;
    }

    // Odświeżenie lease jest fencing checkiem tuż przed punktem bez powrotu.
    // Worker, który utracił token, nie może zapisać Order ze starym snapshotem ceny.
    const leaseRefresh = buildOfferReservationRefresh({
      offerId: offer._id,
      token: acceptanceToken,
      now: new Date(),
    });
    const refreshedReservation = await Offer.updateOne(leaseRefresh.filter, leaseRefresh.update);
    if (!(refreshedReservation.matchedCount ?? refreshedReservation.n)) {
      acceptanceReservation = null;
      return res.status(409).json({
        message: 'Rezerwacja oferty wygasła lub została przejęta. Spróbuj ponownie.',
        code: 'OFFER_ACCEPTANCE_LEASE_LOST',
      });
    }

    const acceptanceLockFilter = buildAcceptanceLockFilter({
      orderId: order._id,
      clientId: req.user._id,
      preserveSettledContactUnlock: isOffersOnlyOrder && !contactUnlockAlreadySettled,
    });
    let acceptedOrder = await Order.findOneAndUpdate(
      acceptanceLockFilter,
      { $set: orderSet },
      { new: true, runValidators: true }
    );

    // Jeśli webhook zdążył odblokować kontakt po naszym odczycie, pierwszy claim
    // celowo nie pasuje. Powtarzamy go bez pól kontaktowych, aby zachować bieżący stan.
    if (!acceptedOrder && isOffersOnlyOrder && !contactUnlockAlreadySettled) {
      const orderSetWithoutContactUnlock = { ...orderSet };
      delete orderSetWithoutContactUnlock.contactUnlockStatus;
      delete orderSetWithoutContactUnlock.contactUnlockFeePln;
      delete orderSetWithoutContactUnlock.contactUnlockedAt;
      acceptedOrder = await Order.findOneAndUpdate(
        buildAcceptanceLockFilter({ orderId: order._id, clientId: req.user._id }),
        { $set: orderSetWithoutContactUnlock },
        { new: true, runValidators: true }
      );
      if (acceptedOrder && contactUnlockIsSettled(acceptedOrder)) {
        contactUnlockAlreadySettled = true;
        requiresContactUnlock = false;
        contactUnlockFeePln = Number(acceptedOrder.contactUnlockFeePln) || 0;
      }
    }

    if (!acceptedOrder) {
      const currentOrder = await Order.findById(order._id)
        .select('acceptedOfferId status provider paymentPreference protectionEligible pricing orderMode');
      if (
        currentOrder &&
        String(currentOrder.acceptedOfferId || '') === String(offer._id) &&
        currentOrder.status === 'accepted' &&
        acceptedOfferProviderMatches(currentOrder, offer)
      ) {
        orderClaimed = true;
        await reconcileAcceptedOfferStatuses(order._id, offer._id, { acceptanceToken });
        acceptanceReservation = null;
        return res.json({
          ok: true,
          orderId: currentOrder._id,
          offerId: offer._id,
          orderMode: currentOrder.orderMode || 'standard',
          paymentMethod: currentOrder.paymentPreference,
          includeGuarantee: !!currentOrder.protectionEligible,
          totalAmount: currentOrder.pricing?.total ?? baseAmount,
          breakdown: currentOrder.pricing,
          alreadyAccepted: true,
        });
      }
      const lostToAnotherOffer = Boolean(
        currentOrder?.acceptedOfferId &&
        String(currentOrder.acceptedOfferId) !== String(offer._id)
      );
      await releaseOfferAcceptanceReservation({
        ...acceptanceReservation,
        status: lostToAnotherOffer ? 'rejected' : 'sent',
      });
      acceptanceReservation = null;
      return res.status(409).json({
        message: 'Zlecenie zostało już zaakceptowane albo nie jest już dostępne.',
        code: 'ORDER_ACCEPTANCE_CONFLICT',
      });
    }

    orderClaimed = true;
    if (!acceptedOfferProviderMatches(acceptedOrder, offer)) {
      throw new Error('Accepted order provider does not match reserved offer provider');
    }
    const rejectedOffers = await reconcileAcceptedOfferStatuses(order._id, offer._id, {
      acceptanceToken,
    });
    acceptanceReservation = null;

    // Powiadomienia są skutkiem ubocznym po nabyciu atomowego locka. Ich błąd nie cofa transakcji.
    const { notifyOfferRejected } = require('../utils/notifier');
    for (const rejectedOffer of rejectedOffers) {
      try {
        await notifyOfferRejected({
          app: req.app,
          orderId: order._id,
          offerId: rejectedOffer._id,
          providerId: rejectedOffer.providerId,
        });
      } catch (notifyError) {
        logger.warn('OFFER_REJECTED_NOTIFY_ERROR:', {
          message: notifyError.message,
          orderId: String(order._id),
          offerId: String(rejectedOffer._id),
        });
      }
    }

    // Sesje Daily.co tylko po opłaceniu — POST /api/video/sessions/create (Stripe PI)
    try {
      const needsPaidVideo =
        order.consultationType === 'video' ||
        (order.isTeleconsultation && !['phone', 'email', 'chat'].includes(order.consultationType));
      if (needsPaidVideo) {
        logger.info(
          `[video] Order ${order._id}: klient opłaci sesję wideo przez checkout (brak auto-tworzenia pokoju Daily)`
        );
      }
    } catch (videoHintErr) {
      logger.warn('[video] offer accept hint:', videoHintErr.message);
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
    try {
      await notifyOfferAccepted({ app: req.app, orderId: order._id, offerId: offer._id });
    } catch (notifyError) {
      logger.warn('OFFER_ACCEPTED_NOTIFY_ERROR:', {
        message: notifyError.message,
        orderId: String(order._id),
        offerId: String(offer._id),
      });
    }

    res.json({
      ok: true,
      orderId: order._id,
      offerId: offer._id,
      orderMode: order.orderMode || 'standard',
      paymentMethod: effectivePaymentFlow,
      includeGuarantee: pricing.includeGuarantee,
      totalAmount: pricing.total,
      paymentDueNow: quote.paymentDueNow,
      breakdown: pricing,
      feeMeta: {
        platformFee,
        platformFeePercent,
        foundingDiscountApplied: feeCalc.foundingDiscountApplied,
        platformFeeBeforeDiscount: feeCalc.platformFeeBeforeDiscount,
        feeExplanation: feeCalc.feeExplanation,
        foundingExpiresAt: feeCalc.foundingExpiresAt,
      },
      suggestAddFavorite: isOffersOnlyOrder,
      providerId: offer.providerId,
      requiresContactUnlock,
      contactUnlockFeePln,
      contactUnlockWaived:
        isOffersOnlyOrder && acceptedOrder.contactUnlockStatus === 'waived',
      clientPlanKey,
    });
  } catch (e) {
    if (acceptanceReservation && !orderClaimed) {
      try {
        await releaseOfferAcceptanceReservation(acceptanceReservation);
      } catch (rollbackError) {
        logger.error('OFFER_ACCEPTANCE_ROLLBACK_ERROR:', {
          message: rollbackError.message,
          offerId: String(acceptanceReservation.offerId),
        });
      }
    }
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
    const currentOffer = await Offer.findById(id).select('providerId status expiresAt');
    if (!currentOffer) return res.status(404).json({ message: "Oferta nie istnieje" });
    if (String(currentOffer.providerId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Brak uprawnień do edycji tej oferty" });
    }

    const { amount, price, message, notes, completionDate, paymentMethod } = req.body;
    const offerSet = {};
    if (typeof amount !== "undefined" || typeof price !== "undefined") {
      const val = amount !== undefined ? Number(amount) : Number(price);
      if (!Number.isFinite(val) || val < 0) return res.status(400).json({ message: "Nieprawidłowa kwota" });
      offerSet.price = val;
      offerSet.amount = val;
    }
    if (typeof message !== "undefined") { offerSet.notes = message; offerSet.message = message; }
    if (typeof notes !== "undefined") { offerSet.notes = notes; offerSet.message = notes; }
    if (typeof completionDate !== "undefined") {
      const parsedCompletionDate = completionDate ? new Date(completionDate) : null;
      if (parsedCompletionDate && Number.isNaN(parsedCompletionDate.getTime())) {
        return res.status(400).json({ message: 'Nieprawidłowy termin realizacji' });
      }
      offerSet.completionDate = parsedCompletionDate;
    }
    if (typeof paymentMethod !== "undefined" && ["system", "external"].includes(paymentMethod)) {
      offerSet.paymentMethod = paymentMethod;
    }

    const now = new Date();
    const offer = await Offer.findOneAndUpdate(
      {
        _id: id,
        providerId: req.user._id,
        status: { $in: ['sent', 'submitted'] },
        $or: [
          { expiresAt: { $gt: now } },
          { expiresAt: null },
          { expiresAt: { $exists: false } },
        ],
      },
      { $set: offerSet },
      { new: true, runValidators: true }
    );

    if (!offer) {
      await Offer.updateOne(
        { _id: id, providerId: req.user._id, status: 'sent', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } }
      );
      const latestOffer = await Offer.findById(id).select('status');
      return res.status(409).json({
        message: `Nie można edytować oferty ze statusem: ${latestOffer?.status || currentOffer.status}. Można edytować tylko aktywne oferty oczekujące.`,
        code: 'OFFER_EDIT_CONFLICT',
      });
    }

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
    const currentOffer = await Offer.findById(id).select('providerId status');
    
    if (!currentOffer) {
      return res.status(404).json({ message: "Oferta nie istnieje" });
    }
    
    // Sprawdź czy to oferta tego providera
    if (String(currentOffer.providerId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Brak uprawnień do anulowania tej oferty" });
    }

    // Status jest częścią filtra zapisu: wycofanie i rezerwacja akceptacji nie
    // mogą jednocześnie wygrać na podstawie wcześniejszego odczytu.
    const offer = await Offer.findOneAndUpdate(
      {
        _id: id,
        providerId: req.user._id,
        status: { $in: ['submitted', 'sent'] },
      },
      {
        $set: { status: 'withdrawn' },
        $unset: {
          acceptanceToken: 1,
          acceptanceReservedBy: 1,
          acceptanceReservedAt: 1,
        },
      },
      { new: true, runValidators: true }
    );

    if (!offer) {
      const latestOffer = await Offer.findById(id).select('status');
      return res.status(409).json({
        message: `Nie można anulować oferty ze statusem: ${latestOffer?.status || currentOffer.status}. Można anulować tylko oferty oczekujące.`,
        code: 'OFFER_WITHDRAW_CONFLICT',
      });
    }
    
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
