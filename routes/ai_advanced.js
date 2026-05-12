// Zaawansowane funkcje AI
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const Order = require('../models/Order');
const Offer = require('../models/Offer');
const User = require('../models/User');
const aiPricingService = require('../services/ai_pricing_service');
const claudeService = require('../services/claude');
const { remember } = require('../utils/cache');
const { evaluateProviderMessagePreflight } = require('../ai/utils/preflightQualityEvaluator');
const { getCompanyProContext } = require('../utils/companyPro');

/**
 * POST /api/ai/advanced/pricing-advice
 * Zaawansowane sugestie cenowe z AI
 */
router.post('/pricing-advice', authMiddleware, async (req, res) => {
  try {
    const { orderId, proposedAmount, orderDescription } = req.body;
    
    if (!orderId || !proposedAmount) {
      return res.status(400).json({ message: 'Brak orderId lub proposedAmount' });
    }

    // Cache key (bez orderDescription, bo może się różnić)
    const cacheKey = `pricingAdvice:${orderId}:${req.user._id}:${Math.round(proposedAmount)}`;
    
    const advice = await remember(cacheKey, 600, async () => {
      return await aiPricingService.generateAdvancedPricingAdvice({
        orderId,
        providerId: req.user._id,
        proposedAmount: Number(proposedAmount),
        orderDescription: orderDescription || ''
      });
    });

    res.json({ advice });
  } catch (error) {
    console.error('Advanced pricing advice error:', error);
    res.status(500).json({ message: error.message || 'Błąd generowania porady cenowej' });
  }
});

/**
 * POST /api/ai/advanced/offer-chat
 * AI chat dla wykonawców - pomoc w tworzeniu ofert
 */
router.post('/offer-chat', authMiddleware, async (req, res) => {
  try {
    const { orderId, message, conversationHistory = [], assistantMode = 'offer' } = req.body;
    
    if (!orderId || !message) {
      return res.status(400).json({ message: 'Brak orderId lub message' });
    }

    // Sprawdź czy użytkownik jest wykonawcą
    const user = await User.findById(req.user._id);
    if (user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą korzystać z AI chat' });
    }

    // Pobierz zlecenie
    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    // Pobierz istniejące oferty wykonawcy dla tego zlecenia
    const existingOffers = await Offer.find({
      orderId,
      providerId: req.user._id
    }).lean();
    const companyProContext = await getCompanyProContext(req.user._id);
    const isCompanyManagerFlow = ['company_owner', 'company_manager'].includes(user.role) || ['owner', 'manager'].includes(user.roleInCompany);
    const shouldUseCompanyPro = companyProContext.eligible && (assistantMode === 'company_pro' || isCompanyManagerFlow);
    const normalizedAssistantMode = shouldUseCompanyPro
      ? 'company_pro'
      : (['offer', 'pricing', 'risks', 'negotiation', 'followup'].includes(assistantMode) ? assistantMode : 'offer');

    // Przygotuj kontekst dla AI
    const context = {
      order: {
        title: order.title,
        description: order.description,
        service: order.service,
        urgency: order.urgency,
        location: order.location?.city || 'nieznana'
      },
      provider: {
        name: user.name,
        rating: user.rating || 0,
        level: user.providerLevel || 'standard'
      },
      existingOffers: existingOffers.map(o => ({
        amount: o.amount,
        message: o.message,
        status: o.status
      })),
      conversationHistory
    };

    // Użyj nowego Provider AI Agents
    try {
      const { runProviderOrchestrator } = require('../ai/agents/providerOrchestrator');
      const { runOfferAgent } = require('../ai/agents/offerAgent');
      const { runPricingProviderAgent } = require('../ai/agents/pricingProviderAgent');
      
      // Przygotuj messages
      const messages = [
        ...conversationHistory.map(m => ({ role: m.role, content: m.text || m.content || m.message })),
        { role: 'user', content: message }
      ];
      
      // Przygotuj kontekst
      const orderContext = {
        service: typeof order.service === 'object' ? order.service?.code : order.service,
        description: order.description,
        urgency: order.urgency,
        location: order.location?.city || order.location || 'nieznana',
        budget: order.budgetRange || (order.budget ? { min: order.budget * 0.8, max: order.budget * 1.2 } : null),
        attachments: order.attachments?.length || 0,
        paymentPreference: order.paymentPreference || 'system',
        assistantMode: normalizedAssistantMode,
        priorityDateTime: order.priorityDateTime || null,
        clientPreferredTerm: order.priorityDateTime ? new Date(order.priorityDateTime).toISOString() : null,
        aiBrief: order.aiBrief ? {
          title: order.aiBrief.title,
          customerSummary: order.aiBrief.customerSummary,
          bullets: order.aiBrief.bullets || [],
          questionsForProvider: order.aiBrief.questionsForProvider || [],
          contextSnapshot: order.aiBrief.contextSnapshot || null,
          safety: order.aiBrief.safety || null
        } : null,
        companyContext: shouldUseCompanyPro ? { companyId: companyProContext.companyId } : null,
        procurementPolicy: shouldUseCompanyPro ? companyProContext.procurementPolicy : null
      };
      
      const providerInfo = {
        name: user.name,
        level: user.providerLevel || user.providerTier || 'standard',
        rating: user.rating || 0,
        services: user.services || [],
        location: user.location
      };
      
      // Wywołaj orchestrator
      const orchestratorResult = await runProviderOrchestrator({
        messages,
        orderContext,
        providerInfo,
        assistantMode: normalizedAssistantMode
      });
      
      // Główna odpowiedź = naturalna wypowiedź. Szczegóły (cena, wskazówki) w agents.
      const messageText = orchestratorResult.reply || 'Jak mogę Ci pomóc?';
      const agents = {};
      
      // Routing do agentów
      if (orchestratorResult.nextStep === 'suggest_offer' || orchestratorResult.nextStep === 'communication_help') {
        try {
          agents.offer = await runOfferAgent({
            orderContext,
            providerInfo,
            existingOffers,
            conversationHistory: messages
          });
        } catch (error) {
          console.error('Offer agent failed:', error);
        }
      } else if (orchestratorResult.nextStep === 'suggest_pricing') {
        try {
          agents.pricing = await runPricingProviderAgent({
            orderContext,
            providerInfo,
            marketData: null
          });
        } catch (error) {
          console.error('Pricing provider agent failed:', error);
        }
      }
      
      res.json({
        response: messageText,
        message: messageText,
        agents,
        assistantModeUsed: normalizedAssistantMode,
        companyPro: { eligible: companyProContext.eligible, active: shouldUseCompanyPro },
        suggestions: agents.offer?.suggestedScope || [],
        tips: agents.offer?.tips || agents.pricing?.tips || [],
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Provider AI agents error, using Claude fallback:', error);
      
      // Fallback do starej metody Claude
      const prompt = buildOfferChatPrompt(context, message);
      
      let aiResponse = null;
      try {
        const rawResponse = await claudeService.analyzeWithClaude({
          description: prompt,
          imageUrls: [],
          lang: 'pl'
        });
        
        if (rawResponse && typeof rawResponse === 'object') {
          aiResponse = {
            message: rawResponse.message || rawResponse.response || JSON.stringify(rawResponse),
            suggestions: rawResponse.suggestions || [],
            tips: rawResponse.tips || []
          };
        } else {
          aiResponse = { message: String(rawResponse) };
        }
      } catch (claudeError) {
        console.warn('Claude AI offer chat failed:', claudeError.message);
        aiResponse = {
          message: 'Przepraszam, nie mogę teraz odpowiedzieć. Spróbuj ponownie później.',
          suggestions: [],
          tips: []
        };
      }
      
      res.json({
        response: aiResponse,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Offer chat error:', error);
    res.status(500).json({ message: error.message || 'Błąd AI chat' });
  }
});

/**
 * POST /api/ai/advanced/offer-message-preflight
 * AI pre-send quality check dla wiadomosci providera
 */
router.post('/offer-message-preflight', authMiddleware, async (req, res) => {
  try {
    const { orderId, message, assistantMode = 'offer' } = req.body || {};
    if (!orderId || !message) {
      return res.status(400).json({ message: 'Brak orderId lub message' });
    }

    const user = await User.findById(req.user._id).lean();
    if (!user || user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą używać preflight AI' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    const quality = await evaluateProviderMessagePreflight({
      orderContext: {
        service: typeof order.service === 'object' ? order.service?.code : order.service,
        urgency: order.urgency || 'normal',
        location: order.location?.city || order.location?.address || '',
        budget: order.budgetRange || order.budget || null,
        attachments: order.attachments?.length || 0
      },
      draft: {
        message,
        assistantMode
      }
    });

    return res.json({ quality });
  } catch (error) {
    console.error('Offer message preflight error:', error);
    return res.status(500).json({ message: error.message || 'Błąd preflight wiadomości' });
  }
});

/**
 * POST /api/ai/advanced/analyze-offers
 * AI rekomendacja: którą ofertę wybrać (dla klienta)
 * Body: { orderId, offers?, topN? } – topN = ile zwrócić w topOfferIds (domyślnie 3 przy 5+ ofertach)
 */
router.post('/analyze-offers', authMiddleware, async (req, res) => {
  try {
    const { orderId, offers: offersFromBody, topN: requestedTopN } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może uzyskać rekomendację ofert' });
    }

    let offers = offersFromBody;
    if (!Array.isArray(offers) || offers.length === 0) {
      offers = await Offer.find({ orderId: order._id })
        .populate('providerId', 'name rating ratingAvg ratingCount')
        .sort({ createdAt: -1 })
        .lean();
    }

    const wantTopN = Math.min(Math.max(Number(requestedTopN) || 0, 0), 5);
    const hasManyOffers = offers.length >= 5;

    if (offers.length === 0) {
      return res.json({
        recommendedOfferId: null,
        topOfferIds: [],
        reasoning: 'Brak złożonych ofert. Poczekaj na propozycje wykonawców.',
        comparison: null
      });
    }
    if (offers.length === 1) {
      const o = offers[0];
      const id = o._id || o.id;
      return res.json({
        recommendedOfferId: id,
        topOfferIds: [id],
        reasoning: 'Masz jedną ofertę – możesz ją zaakceptować lub poczekać na kolejne.',
        comparison: null
      });
    }

    const offersSummary = offers.map((o, i) => {
      const provider = o.providerId || o.providerMeta || {};
      const name = provider.name || 'Wykonawca';
      const rating = provider.rating ?? provider.ratingAvg ?? 0;
      const amount = o.amount ?? o.price ?? 0;
      const message = (o.message || o.notes || '').substring(0, 200);
      return `Oferta ${i + 1} (id: ${o._id || o.id}): ${amount} zł, wykonawca: ${name}, ocena: ${rating}, opis: ${message || 'brak'}`;
    }).join('\n');

    const systemPrompt = `Jesteś asystentem pomagającym klientowi wybrać najlepszą ofertę w serwisie Helpfli.
Odpowiedz WYŁĄCZNIE poprawnym JSON bez markdown, bez tekstu przed/po.
Format: {"recommendedOfferId": "ObjectId wybranej oferty", "reasoning": "2-4 zdania po polsku dlaczego ta oferta", "comparison": "krótkie porównanie po kolei (opcjonalnie)"}.
recommendedOfferId musi być dokładnie jednym z id ofert z listy.`;

    const userMessage = `Zlecenie: ${(order.description || '').substring(0, 300)}

Oferty:
${offersSummary}

Którą ofertę rekomendujesz i dlaczego? Odpowiedz tylko JSON.`;

    let recommendedOfferId = null;
    let reasoning = 'Porównanie cen, ocen wykonawców i opisów ofert.';
    let comparison = null;

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: process.env.CLAUDE_DEFAULT || 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          temperature: 0.3,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        });
        const text = (response.content[0]?.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        if (parsed && parsed.recommendedOfferId) {
          recommendedOfferId = parsed.recommendedOfferId;
          reasoning = parsed.reasoning || reasoning;
          comparison = parsed.comparison || null;
        }
      }
    } catch (aiErr) {
      console.warn('AI analyze-offers fallback:', aiErr.message);
    }

    const heuristicSort = (list) => [...list].sort((a, b) => {
      const priceA = a.amount ?? a.price ?? 0;
      const priceB = b.amount ?? b.price ?? 0;
      const ratingA = (a.providerId?.rating ?? a.providerId?.ratingAvg ?? 0) || 0;
      const ratingB = (b.providerId?.rating ?? b.providerId?.ratingAvg ?? 0) || 0;
      const scoreA = ratingA * 20 - priceA / 50;
      const scoreB = ratingB * 20 - priceB / 50;
      return scoreB - scoreA;
    });

    if (!recommendedOfferId) {
      const sorted = heuristicSort(offers);
      const best = sorted[0];
      recommendedOfferId = best._id || best.id;
      reasoning = `Rekomendacja na podstawie ceny i ocen: oferta ${best.amount ?? best.price} zł (${(best.providerId?.name || best.providerMeta?.name) || 'wykonawca'}).`;
    }

    const n = (hasManyOffers && wantTopN > 0) ? Math.min(wantTopN, offers.length) : (hasManyOffers ? 3 : Math.min(3, offers.length));
    const sortedHeuristic = heuristicSort(offers);
    const recIdStr = String(recommendedOfferId);
    const rest = sortedHeuristic.filter(o => String(o._id || o.id) !== recIdStr).slice(0, n - 1).map(o => String(o._id || o.id));
    const topOfferIds = [recIdStr, ...rest].slice(0, n);

    res.json({
      recommendedOfferId,
      topOfferIds: topOfferIds.length ? topOfferIds : (recommendedOfferId ? [String(recommendedOfferId)] : []),
      reasoning,
      comparison
    });
  } catch (error) {
    console.error('Analyze offers error:', error);
    res.status(500).json({ message: error.message || 'Błąd analizy ofert' });
  }
});

/**
 * GET /api/ai/advanced/order-tags/:orderId
 * Pobierz tagi zlecenia (jeśli istnieją)
 */
router.get('/order-tags/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    
    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    // Jeśli tagi już istnieją, zwróć je
    if (order.aiTags && order.aiTags.length > 0) {
      return res.json({
        tags: order.aiTags,
        confidence: order.aiTagsConfidence || 0.5,
        reasoning: order.aiTagsReasoning || '',
        orderId
      });
    }

    // Jeśli tagi nie istnieją, zwróć pustą odpowiedź
    res.json({
      tags: [],
      confidence: 0,
      reasoning: '',
      orderId
    });
  } catch (error) {
    console.error('Get order tags error:', error);
    res.status(500).json({ message: error.message || 'Błąd pobierania tagów' });
  }
});

function offerAmountPln(o) {
  const v = o?.amount ?? o?.price;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isOfferAwaitingDecision(o) {
  const s = String(o?.status || 'sent').toLowerCase();
  return s === 'sent' || s === 'submitted';
}

/**
 * Heurystyka pod widok „szansa / wskazówki” dla wykonawcy (bez osobnego wywołania LLM).
 * Zwraca successProbability w skali 0–100 (procent), pola pod frontend: positiveFactors, negativeFactors, actionableTips.
 */
function buildProviderOrderWinPreview(order, offers, userId) {
  const uid = userId != null ? String(userId) : '';
  const pending = (offers || []).filter(isOfferAwaitingDecision);
  const mine = uid ? pending.find((o) => String(o.providerId) === uid) : null;
  const competitors = mine ? pending.filter((o) => String(o.providerId) !== uid) : pending;

  const positiveFactors = [];
  const negativeFactors = [];
  const actionableTips = [];

  const amounts = pending.map(offerAmountPln).filter((n) => n != null);
  const minAm = amounts.length ? Math.min(...amounts) : null;
  const maxAm = amounts.length ? Math.max(...amounts) : null;
  const avgAm = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : null;

  let score = 46;

  if (mine) {
    const myAm = offerAmountPln(mine);
    const msg = String(mine.message || mine.notes || '').trim();

    if (competitors.length >= 4) {
      negativeFactors.push('Na zleceniu jest bardzo dużo ofert — klient ma szeroki wybór.');
      actionableTips.push('Zadbaj o krótką, konkretną wiadomość i jasny termin realizacji, żeby Twoja oferta nie zginęła w tłoku.');
      score -= 18;
    } else if (competitors.length >= 2) {
      negativeFactors.push('Są inne aktywne oferty obok Twojej.');
      actionableTips.push('W opisie dopisz: doświadczenie z podobnymi zleceniami, co dokładnie obejmuje cena i kiedy możesz zacząć.');
      score -= 10;
    } else if (competitors.length === 1) {
      actionableTips.push('Porównaj się z drugą ofertą — dopisz jednozdaniowe wyróżnienie (np. szybszy termin, gwarancja, dojazd).');
      score -= 4;
    } else {
      positiveFactors.push('Przy tym zleceniu nie widać jeszcze konkurencyjnych ofert obok Twojej.');
      actionableTips.push('Utrzymaj konkurencyjną cenę i czytelny opis, zanim pojawią się kolejne oferty.');
      score += 8;
    }

    if (msg.length < 25) {
      negativeFactors.push('Opis oferty jest bardzo krótki albo go brakuje.');
      actionableTips.push('Dodaj 2–4 zdania: co zrobisz, czego dotyczy sprawa klienta oraz czy w cenie są części / dojazd.');
      score -= 12;
    } else if (msg.length >= 90) {
      positiveFactors.push('Masz rozbudowany opis — ułatwia to klientowi ocenę oferty.');
      score += 6;
    }

    if (myAm != null && avgAm != null && myAm > avgAm * 1.12) {
      negativeFactors.push('Twoja kwota jest wyraźnie wyższa niż średnia złożonych ofert.');
      actionableTips.push('Jeśli zostajesz przy wyższej cenie — uzasadnij: oryginalne części, gwarancja, szybszy termin lub dojazd.');
      score -= 14;
    } else if (myAm != null && minAm != null && competitors.length > 0 && myAm <= minAm * 1.03) {
      positiveFactors.push('Jesteś w najniższym (lub bardzo bliskim) przedziale cenowym wśród ofert.');
      score += 8;
    } else if (myAm != null && maxAm != null && competitors.length > 0 && myAm >= maxAm * 0.98) {
      actionableTips.push('Rozważ nieco niższą kwotę albo pakiet usług w jednej cenie, jeśli chcesz być bardziej konkurencyjny.');
      score -= 6;
    }

    const completion = mine.completionDate ? new Date(mine.completionDate) : null;
    const pref = order.priorityDateTime ? new Date(order.priorityDateTime) : null;
    if (completion && pref && !Number.isNaN(completion.getTime()) && !Number.isNaN(pref.getTime())) {
      if (completion.getTime() > pref.getTime() + 36 * 60 * 60 * 1000) {
        negativeFactors.push('Proponowany przez Ciebie termin jest wyraźnie późniejszy niż preferencja klienta.');
        actionableTips.push('Jeśli możesz wcześniej — zmień termin w edycji oferty albo napisz, że da się przyspieszyć.');
        score -= 10;
      }
    }

    const urg = String(order.urgency || '').toLowerCase();
    if (urg === 'urgent' || urg === 'high' || urg === 'pilne') {
      actionableTips.push('Zlecenie wygląda na pilne — podkreśl szybką reakcję (np. dziś/jutro) i potwierdź możliwość kontaktu.');
      score -= competitors.length > 0 ? 3 : 0;
    }
  } else {
    actionableTips.push('Gdy złożysz ofertę, wrócimy z wskazówkami dopasowanymi do kwoty, opisu i konkurencji.');
    score = 34;
  }

  const acceptedId = order.acceptedOfferId && String(order.acceptedOfferId);
  const mineId = mine && mine._id && String(mine._id);
  const terminal = ['accepted', 'completed', 'closed', 'paid'].includes(String(order.status || '').toLowerCase());
  if (terminal && acceptedId && mineId && acceptedId === mineId) {
    score = Math.max(score, 93);
    positiveFactors.push('Twoja oferta została zaakceptowana.');
  } else if (terminal && mine) {
    score = Math.min(score, 6);
    negativeFactors.push('Zlecenie zostało już obsadzone (inna oferta).');
  }

  const successProbability = Math.round(Math.min(91, Math.max(5, score)));
  const isTopChoice = Boolean(mine && successProbability >= 68 && negativeFactors.length <= 1);

  const dedup = (arr) => [...new Set((arr || []).filter(Boolean))];
  const actionableTipsU = dedup(actionableTips).slice(0, 6);

  return {
    successProbability,
    confidence: 0.55,
    positiveFactors: dedup(positiveFactors).slice(0, 5),
    negativeFactors: dedup(negativeFactors).slice(0, 5),
    recommendations: actionableTipsU,
    actionableTips: actionableTipsU,
    factors: {
      positive: dedup(positiveFactors).slice(0, 5),
      negative: dedup(negativeFactors).slice(0, 5)
    },
    estimatedTimeToAccept: pending.length >= 4 ? '1–3 dni' : '3–7 dni',
    aiEnhanced: false,
    isTopChoice
  };
}

/**
 * GET /api/ai/advanced/order-prediction/:orderId
 * Pobierz predykcję sukcesu zlecenia (jeśli istnieje)
 */
router.get('/order-prediction/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    
    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    const offers = await Offer.find({ orderId }).lean();
    const preview = buildProviderOrderWinPreview(order, offers, req.user?._id);

    res.json(preview);
  } catch (error) {
    console.error('Get order prediction error:', error);
    res.status(500).json({ message: error.message || 'Błąd pobierania predykcji' });
  }
});

/**
 * POST /api/ai/advanced/auto-tag-order
 * Automatyczne tagowanie zlecenia z AI
 */
router.post('/auto-tag-order', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    // Przygotuj prompt dla AI
    const prompt = `Przeanalizuj poniższe zlecenie i przypisz mu odpowiednie tagi.

Zlecenie:
- Tytuł: ${order.title || 'Brak'}
- Opis: ${order.description || 'Brak'}
- Usługa: ${order.service || 'nieznana'}
- Pilność: ${order.urgency || 'normal'}

Przypisz tagi z następujących kategorii:
- pilność: urgent, normal, flexible
- złożoność: simple, medium, complex
- typ: repair, installation, maintenance, consultation, other
- lokalizacja: indoor, outdoor, both
- wymagania: tools_needed, materials_needed, expertise_required

Odpowiedz w formacie JSON:
{
  "tags": ["tag1", "tag2", "tag3"],
  "confidence": 0.0-1.0,
  "reasoning": "krótkie uzasadnienie"
}`;

    let tags = [];
    let confidence = 0.5;
    let reasoning = '';

    try {
      const rawResponse = await claudeService.analyzeWithClaude({
        description: prompt,
        imageUrls: [],
        lang: 'pl'
      });

      if (rawResponse && typeof rawResponse === 'object') {
        tags = rawResponse.tags || [];
        confidence = rawResponse.confidence || 0.5;
        reasoning = rawResponse.reasoning || '';
      }
    } catch (error) {
      console.warn('AI tagging failed, using fallback:', error.message);
      // Fallback - podstawowe tagi na podstawie danych
      tags = generateFallbackTags(order);
    }

    // Zaktualizuj zlecenie
    await Order.findByIdAndUpdate(orderId, {
      $set: {
        aiTags: tags,
        aiTagsConfidence: confidence,
        aiTagsReasoning: reasoning,
        aiTaggedAt: new Date()
      }
    });

    res.json({
      tags,
      confidence,
      reasoning,
      orderId
    });
  } catch (error) {
    console.error('Auto-tag order error:', error);
    res.status(500).json({ message: error.message || 'Błąd automatycznego tagowania' });
  }
});

/**
 * POST /api/ai/advanced/predict-success
 * Predykcja sukcesu zlecenia
 */
router.post('/predict-success', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    // Pobierz dane o podobnych zleceniach
    const similarOrders = await Order.find({
      service: order.service,
      status: { $in: ['completed', 'closed', 'paid'] },
      createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
    })
      .select('status createdAt amountTotal')
      .limit(50)
      .lean();

    const successRate = similarOrders.length > 0 
      ? similarOrders.filter(o => o.status === 'completed' || o.status === 'paid').length / similarOrders.length
      : 0.5;

    // Pobierz oferty dla tego zlecenia
    const offers = await Offer.find({ orderId }).lean();
    const offerCount = offers.length;
    const avgOfferAmount = offers.length > 0
      ? offers.reduce((sum, o) => sum + o.amount, 0) / offers.length
      : 0;

    // Przygotuj prompt dla AI
    const prompt = `Przeanalizuj poniższe zlecenie i oszacuj prawdopodobieństwo jego sukcesu (zakończenia z akceptacją oferty).

Zlecenie:
- Tytuł: ${order.title || 'Brak'}
- Opis: ${order.description || 'Brak'}
- Usługa: ${order.service || 'nieznana'}
- Pilność: ${order.urgency || 'normal'}
- Lokalizacja: ${order.location?.city || 'nieznana'}

Statystyki:
- Liczba ofert: ${offerCount}
- Średnia cena ofert: ${Math.round(avgOfferAmount)} zł
- Wskaźnik sukcesu podobnych zleceń: ${Math.round(successRate * 100)}%

Odpowiedz w formacie JSON:
{
  "successProbability": 0.0-1.0,
  "confidence": 0.0-1.0,
  "factors": {
    "positive": ["czynnik pozytywny 1", "czynnik pozytywny 2"],
    "negative": ["czynnik negatywny 1", "czynnik negatywny 2"]
  },
  "recommendations": ["rekomendacja 1", "rekomendacja 2"],
  "estimatedTimeToAccept": "1-3 dni" lub "3-7 dni" lub "7+ dni"
}`;

    let prediction = null;

    try {
      const rawResponse = await claudeService.analyzeWithClaude({
        description: prompt,
        imageUrls: [],
        lang: 'pl'
      });

      if (rawResponse && typeof rawResponse === 'object') {
        prediction = {
          successProbability: rawResponse.successProbability || successRate,
          confidence: rawResponse.confidence || 0.6,
          factors: rawResponse.factors || { positive: [], negative: [] },
          recommendations: rawResponse.recommendations || [],
          estimatedTimeToAccept: rawResponse.estimatedTimeToAccept || '3-7 dni',
          aiEnhanced: true
        };
      }
    } catch (error) {
      console.warn('AI prediction failed, using fallback:', error.message);
    }

    // Fallback jeśli AI nie działa
    if (!prediction) {
      prediction = {
        successProbability: successRate,
        confidence: 0.5,
        factors: {
          positive: offerCount > 0 ? ['Zlecenie ma już oferty'] : [],
          negative: offerCount === 0 ? ['Brak ofert'] : []
        },
        recommendations: [],
        estimatedTimeToAccept: '3-7 dni',
        aiEnhanced: false
      };
    }

    res.json({
      prediction,
      orderId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Predict success error:', error);
    res.status(500).json({ message: error.message || 'Błąd predykcji sukcesu' });
  }
});

// Helper functions

function buildOfferChatPrompt(context, userMessage) {
  const { order, provider, existingOffers, conversationHistory } = context;

  let historyText = '';
  if (conversationHistory.length > 0) {
    historyText = '\n\nHistoria rozmowy:\n' + conversationHistory
      .slice(-5) // Ostatnie 5 wiadomości
      .map((msg, i) => `${i + 1}. ${msg.role === 'user' ? 'Użytkownik' : 'AI'}: ${msg.content}`)
      .join('\n');
  }

  return `Jesteś asystentem AI pomagającym wykonawcom w tworzeniu skutecznych ofert w serwisie Helpfli.

Zlecenie:
- Tytuł: ${order.title}
- Opis: ${order.description}
- Usługa: ${order.service}
- Pilność: ${order.urgency}
- Lokalizacja: ${order.location}

Wykonawca:
- Nazwa: ${provider.name}
- Ocena: ${provider.rating}/5
- Poziom: ${provider.level}

Istniejące oferty wykonawcy:
${existingOffers.length > 0 
  ? existingOffers.map((o, i) => `${i + 1}. ${o.amount} zł - ${o.message || 'Brak opisu'} (${o.status})`).join('\n')
  : 'Brak wcześniejszych ofert'}

${historyText}

Wiadomość użytkownika: ${userMessage}

Odpowiedz pomocnie i profesjonalnie. Jeśli użytkownik pyta o cenę, zaproponuj widełki. Jeśli pyta o opis oferty, zaproponuj przykładowy tekst. Odpowiedz w formacie JSON:
{
  "message": "twoja odpowiedź",
  "suggestions": ["sugestia 1", "sugestia 2"],
  "tips": ["wskazówka 1", "wskazówka 2"]
}`;
}

function generateFallbackTags(order) {
  const tags = [];
  
  // Pilność
  if (order.urgency === 'now') tags.push('urgent');
  else if (order.urgency === 'today') tags.push('normal');
  else tags.push('flexible');

  // Złożoność (na podstawie długości opisu)
  const descLength = (order.description || '').length;
  if (descLength < 50) tags.push('simple');
  else if (descLength < 200) tags.push('medium');
  else tags.push('complex');

  // Typ (na podstawie usługi)
  const service = (order.service || '').toLowerCase();
  if (service.includes('naprawa') || service.includes('repair')) tags.push('repair');
  else if (service.includes('instalacja') || service.includes('installation')) tags.push('installation');
  else if (service.includes('serwis') || service.includes('maintenance')) tags.push('maintenance');
  else tags.push('other');

  return tags;
}

module.exports = router;

