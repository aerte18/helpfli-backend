// routes/ai.js
const express = require("express");
const { conciergeLLMExtract } = require("../utils/llm");
const { authMiddleware: auth } = require("../middleware/authMiddleware");

const router = express.Router();
const { computePricingBands } = require("../utils/pricing");
const Order = require("../models/Order");
const Service = require("../models/Service");

const logger = require("../utils/logger");
logger.debug("✅ AI routes loaded successfully");

// Endpointy testowe – tylko poza produkcją
if (process.env.NODE_ENV !== "production") {
  router.get("/test", (req, res) => {
    res.json({ message: "AI routes working!", timestamp: new Date().toISOString() });
  });

  router.post("/concierge/test", async (req, res) => {
    try {
      const { problemText, location } = req.body || {};
      if (!problemText || typeof problemText !== "string") {
        return res.status(400).json({ message: "Brak lub nieprawidłowy 'problemText'." });
      }
      const userContext = { userId: "test-user", city: location?.city || null };
      const extracted = await conciergeLLMExtract(problemText, userContext);
      if (location && extracted?.order_payload) {
        extracted.order_payload.location = {
          city: location.city || null,
          lat: location.lat || null,
          lng: location.lng || null,
        };
      }
      const searchParams = {
        service: extracted?.detected_service_slug || extracted?.order_payload?.service || "inne",
        city: location?.city || null,
        lat: location?.lat || null,
        lng: location?.lng || null,
        limit: 3
      };
      const response = {
        advice: {
          diy_steps: extracted?.diy_steps || [],
          risk_level: extracted?.risk_level || "low",
          recommended_urgency: extracted?.recommended_urgency || "normal",
        },
        order: extracted?.order_payload || null,
        query: searchParams,
        followups: extracted?.followup_questions || [],
        debug: {
          category: extracted?.category,
          detected_service_slug: extracted?.detected_service_slug,
          provider_match_tags: extracted?.provider_match_tags || []
        }
      };
      return res.json(response);
    } catch (err) {
      logger.error("AI Concierge TEST error:", err);
      return res.status(500).json({ message: "Błąd AI Concierge TEST." });
    }
  });
}

/**
 * POST /api/ai/concierge
 * body: { problemText: string, location?: {city, lat, lng} }
 * zwraca: { advice, order, query, followups }
 */
router.post("/concierge", auth, async (req, res) => {
  try {
    logger.debug("AI Concierge request", { user: req.user?._id });
    const { problemText, location } = req.body || {};
    if (!problemText || typeof problemText !== "string") {
      console.log("AI Concierge error: Invalid problemText");
      return res.status(400).json({ message: "Brak lub nieprawidłowy 'problemText'." });
    }

    // Kontekst (np. miasto użytkownika, jeśli masz w profilu)
    const userContext = {
      userId: req.user?._id || null,
      city: location?.city || null
    };

    console.log("AI Concierge: Calling LLM with:", { problemText, userContext });
    const extracted = await conciergeLLMExtract(problemText, userContext);
    console.log("AI Concierge: LLM response:", extracted);

    // Jeśli na froncie masz dostęp do geolokacji — nadpisz w order_payload.location
    if (location && extracted?.order_payload) {
      extracted.order_payload.location = {
        city: location.city || null,
        lat: location.lat || null,
        lng: location.lng || null,
      };
    }

    // Parametry do /api/search po stronie frontu
    const searchParams = {
      service: extracted?.detected_service_slug || extracted?.order_payload?.service || "inne",
      city: location?.city || null,
      lat: location?.lat || null,
      lng: location?.lng || null,
      limit: 3
    };

    const response = {
      advice: {
        diy_steps: extracted?.diy_steps || [],
        risk_level: extracted?.risk_level || "low",
        recommended_urgency: extracted?.recommended_urgency || "normal",
      },
      order: extracted?.order_payload || null,
      query: searchParams,
      followups: extracted?.followup_questions || [],
      debug: {
        category: extracted?.category,
        detected_service_slug: extracted?.detected_service_slug,
        provider_match_tags: extracted?.provider_match_tags || []
      }
    };
    
    console.log("AI Concierge: Sending response:", response);
    return res.json(response);
  } catch (err) {
    console.error("AI Concierge error:", err);
    return res.status(500).json({ message: "Błąd AI Concierge." });
  }
});

/**
 * GET /api/ai/pricing?service=...&city=...&lat=...&lng=...&urgency=normal|today|now
 */
router.get("/pricing", auth, async (req, res) => {
  try {
    const { service, city, lat, lng, urgency } = req.query || {};
    const data = await computePricingBands({
      service: service || "inne",
      city: city || null,
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
      urgency: ["normal", "today", "now"].includes(urgency) ? urgency : "normal",
    });
    res.json(data);
  } catch (e) {
    console.error("AI Pricing error:", e);
    res.status(500).json({ message: "Błąd AI Pricing" });
  }
});

// Sugestia widełek cenowych na podstawie serwisu i poziomu
router.get('/price-suggest', async (req,res)=>{
  try {
    const { serviceId, level='standard' } = req.query;
    const svc = await Service.findById(serviceId);
    if (!svc) return res.status(404).json({ message: 'Brak usługi' });
    // zakładamy, że Service ma pola priceBaseMin/Max per level
    const rng = svc.priceRanges?.[level] || { min: svc.priceMin || 50, max: svc.priceMax || 150 };
    res.json(rng);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania sugestii cenowej' });
  }
});

// Zapis draftu zlecenia (z AI)
router.post('/draft', auth, async (req,res)=>{
  try {
    const { serviceId, description, location, preferredTime, budgetMax } = req.body;
    const draft = await Order.create({ 
      client: req.user._id, 
      service: serviceId, 
      description, 
      location, 
      status: 'draft', 
      budgetMax 
    });
    res.json(draft);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas zapisywania draftu' });
  }
});

// 1‑klik: z draftu → aktywne i powiadom wykonawców (Twoja logika broadcastu)
router.post('/draft/:id/submit', auth, async (req,res)=>{
  try {
    const ord = await Order.findOne({ _id: req.params.id, client: req.user._id });
    if (!ord) return res.status(404).json({ message: 'Draft nie istnieje' });
    
    ord.status = 'open';
    ord.createdAt = new Date();
    await ord.save();
    
    // TODO: wyślij notyfikacje do dopasowanych wykonawców (np. Socket/Push)
    res.json({ ok:true, orderId: ord._id });
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas wysyłania zlecenia' });
  }
});

/**
 * POST /api/ai/assistant/chat - AI asystent do pomocy w tworzeniu zleceń
 */
router.post("/assistant/chat", auth, async (req, res) => {
  try {
    const { message, conversationHistory = [], orderData = {} } = req.body;
    
    if (!message || typeof message !== "string") {
      return res.status(400).json({ message: "Brak wiadomości od użytkownika" });
    }

    // Sprawdź czy to początek rozmowy
    const isFirstMessage = conversationHistory.length === 0;
    
    let response;
    if (isFirstMessage) {
      // Pierwsza wiadomość - rozpocznij proces zbierania informacji
      response = await startOrderCreationProcess(message, req.user);
    } else {
      // Kontynuacja rozmowy - zbieraj więcej informacji
      response = await continueOrderCreationProcess(message, conversationHistory, orderData, req.user);
    }

    res.json(response);
  } catch (error) {
    console.error("AI Assistant error:", error);
    res.status(500).json({ message: "Błąd AI asystenta" });
  }
});

/**
 * POST /api/ai/assistant/create-order - Utwórz zlecenie na podstawie rozmowy z AI
 */
router.post("/assistant/create-order", auth, async (req, res) => {
  try {
    const { orderData, conversationHistory } = req.body;
    
    if (!orderData || !orderData.service || !orderData.description) {
      return res.status(400).json({ message: "Niepełne dane zlecenia" });
    }

    // Sprawdź czy potrzebne są jeszcze jakieś informacje
    const missingInfo = checkMissingOrderInfo(orderData);
    if (missingInfo.length > 0) {
      return res.json({
        type: "missing_info",
        message: "Potrzebuję jeszcze kilku informacji:",
        missingFields: missingInfo,
        suggestions: generateSuggestionsForMissingFields(missingInfo)
      });
    }

    // Utwórz zlecenie
    const order = await Order.create({
      client: req.user._id,
      service: orderData.service,
      description: orderData.description,
      location: orderData.location || "Do ustalenia",
      status: "open",
      type: "open",
      priority: orderData.priority || "normal",
      priorityFee: orderData.priority === "priority" ? 2000 : 0,
      budget: orderData.budget,
      urgency: orderData.urgency,
      contactPreference: orderData.contactPreference,
      locationLat: orderData.locationLat,
      locationLon: orderData.locationLon,
      attachments: orderData.attachments || [],
      createdAt: new Date(),
    });

    res.json({
      type: "order_created",
      message: "✅ Zlecenie zostało utworzone! Wykonawcy będą mogli składać propozycje.",
      orderId: order._id,
      order: order
    });

  } catch (error) {
    console.error("Create order from AI error:", error);
    res.status(500).json({ message: "Błąd tworzenia zlecenia" });
  }
});

// Funkcje pomocnicze dla AI asystenta

async function startOrderCreationProcess(message, user) {
  try {
    // Użyj istniejącej funkcji conciergeLLMExtract
    const extracted = await conciergeLLMExtract(message, { userId: user._id });
    
    // Sprawdź czy AI wykrył problem
    if (extracted && extracted.problem_summary) {
      return {
        type: "problem_analyzed",
        message: `Rozumiem! ${extracted.problem_summary}\n\nCzy mogę pomóc Ci znaleźć rozwiązanie?`,
        orderData: {
          service: extracted.detected_service_slug || "inne",
          description: extracted.problem_summary,
          urgency: extracted.recommended_urgency || "normal",
          riskLevel: extracted.risk_level || "low"
        },
        suggestions: {
          diySteps: extracted.diy_steps || [],
          followupQuestions: extracted.followup_questions || [],
          needsPhoto: checkIfNeedsPhoto(extracted.detected_service_slug)
        }
      };
    } else {
      return {
        type: "need_more_info",
        message: "Opisz mi swój problem bardziej szczegółowo. Co się dzieje?",
        suggestions: [
          "Czy to problem z hydrauliką?",
          "Czy to problem elektryczny?",
          "Czy to problem z AGD?",
          "Czy to coś innego?"
        ]
      };
    }
  } catch (error) {
    console.error("Start order creation error:", error);
    return {
      type: "error",
      message: "Przepraszam, wystąpił błąd. Spróbuj ponownie opisać swój problem."
    };
  }
}

async function continueOrderCreationProcess(message, conversationHistory, orderData, user) {
  try {
    // Sprawdź czy użytkownik podał lokalizację
    if (message.toLowerCase().includes("warszawa") || message.toLowerCase().includes("kraków") || 
        message.toLowerCase().includes("gdańsk") || message.toLowerCase().includes("wrocław")) {
      orderData.location = message;
      return {
        type: "location_added",
        message: `Dziękuję! Lokalizacja: ${message}\n\nCzy możesz dodać zdjęcie problemu? To pomoże wykonawcom lepiej zrozumieć sytuację.`,
        orderData: orderData,
        needsPhoto: true
      };
    }

    // Sprawdź czy użytkownik podał budżet
    const budgetMatch = message.match(/(\d+)\s*zł/);
    if (budgetMatch) {
      orderData.budget = parseInt(budgetMatch[1]);
      return {
        type: "budget_added",
        message: `Budżet: ${budgetMatch[1]} zł\n\nCzy to pilne? Kiedy potrzebujesz usługi?`,
        orderData: orderData,
        suggestions: ["Dziś", "Jutro", "Ten tydzień", "Kiedyś w przyszłości"]
      };
    }

    // Sprawdź pilność
    if (message.toLowerCase().includes("dziś") || message.toLowerCase().includes("pilne")) {
      orderData.urgency = "today";
      orderData.priority = "priority";
      return {
        type: "urgency_set",
        message: "Rozumiem, to pilne! Czy chcesz dodać priorytet do zlecenia (+20 zł) żeby było widoczne na górze listy?",
        orderData: orderData,
        suggestions: ["Tak, dodaj priorytet", "Nie, standardowe zlecenie"]
      };
    }

    // Sprawdź czy użytkownik potwierdził priorytet
    if (message.toLowerCase().includes("tak") && orderData.urgency === "today") {
      orderData.priority = "priority";
      return {
        type: "ready_to_create",
        message: "Świetnie! Mam wszystkie potrzebne informacje. Czy chcesz utworzyć zlecenie?",
        orderData: orderData,
        canCreate: true
      };
    }

    // Sprawdź czy użytkownik odrzucił priorytet
    if (message.toLowerCase().includes("nie") && orderData.urgency === "today") {
      orderData.priority = "normal";
      return {
        type: "ready_to_create",
        message: "Rozumiem! Czy chcesz utworzyć standardowe zlecenie?",
        orderData: orderData,
        canCreate: true
      };
    }

    // Sprawdź czy użytkownik potwierdził utworzenie zlecenia
    if (message.toLowerCase().includes("tak") && orderData.service && orderData.description) {
      return {
        type: "creating_order",
        message: "Tworzę zlecenie...",
        orderData: orderData,
        creating: true
      };
    }

    // Domyślnie - zbieraj więcej informacji
    return {
      type: "need_more_info",
      message: "Czy możesz podać więcej szczegółów?",
      orderData: orderData,
      suggestions: [
        "Gdzie jest problem? (adres/miejscowość)",
        "Jaki jest Twój budżet?",
        "Kiedy potrzebujesz usługi?",
        "Czy możesz dodać zdjęcie?"
      ]
    };

  } catch (error) {
    console.error("Continue order creation error:", error);
    return {
      type: "error",
      message: "Przepraszam, wystąpił błąd. Spróbuj ponownie."
    };
  }
}

function checkMissingOrderInfo(orderData) {
  const missing = [];
  
  if (!orderData.service) missing.push("service");
  if (!orderData.description) missing.push("description");
  if (!orderData.location) missing.push("location");
  
  return missing;
}

function generateSuggestionsForMissingFields(missingFields) {
  const suggestions = {};
  
  if (missingFields.includes("service")) {
    suggestions.service = ["Hydraulik", "Elektryk", "AGD", "Złota rączka", "Inne"];
  }
  
  if (missingFields.includes("location")) {
    suggestions.location = ["Podaj adres lub miejscowość"];
  }
  
  return suggestions;
}

function checkIfNeedsPhoto(serviceSlug) {
  const photoServices = [
    "hydraulik_naprawa",
    "elektryk_naprawa", 
    "agd_pralka",
    "ogrzewanie_serwis"
  ];
  
  return photoServices.includes(serviceSlug);
}

/**
 * POST /api/ai/triage - MVP AI Triage endpoint
 * Analizuje problem i zwraca: severity, suggestedService, selfFixSteps, recommendedMode, priceRange
 */
router.post("/triage", async (req, res) => {
  try {
    const { description, location, service } = req.body;
    
    // Walidacja
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return res.status(400).json({ error: 'Description required (min 10 characters)' });
    }
    
    if (!location || (!location.address && !location.city)) {
      return res.status(400).json({ error: 'Location required (address or city)' });
    }
    
    // Wywołaj AI (Claude/OpenAI) z promptem
    let triageResult;
    try {
      // Użyj istniejącego LLM utility
      const aiResponse = await conciergeLLMExtract(description, {
        userId: req.user?._id || null,
        city: location.city || null
      });
      
      // Jeśli conciergeLLMExtract zwraca już strukturę podobną do triage, użyj jej
      if (aiResponse && aiResponse.service) {
        // Mapuj odpowiedź concierge na format triage
        triageResult = {
          severity: determineSeverity(description, aiResponse),
          suggestedService: aiResponse.service || service || 'inne',
          selfFixSteps: aiResponse.selfFixSteps || [],
          recommendedMode: determineRecommendedMode(description, aiResponse),
          priceRange: {
            min: aiResponse.priceQuotedMin || 100,
            max: aiResponse.priceQuotedMax || 500
          }
        };
      } else {
        // Fallback: prosty parsing lub hardcoded v1
        triageResult = {
          severity: 'medium',
          suggestedService: service || 'inne',
          selfFixSteps: ['Sprawdź podstawowe przyczyny', 'Wyłącz zasilanie jeśli dotyczy', 'Skontaktuj się z fachowcem'],
          recommendedMode: 'flexible',
          priceRange: { min: 100, max: 500 }
        };
      }
    } catch (aiError) {
      logger.warn('AI_TRIAGE_LLM_ERROR:', aiError.message);
      // Fallback v1: prosty hardcoded response
      triageResult = {
        severity: 'medium',
        suggestedService: service || 'inne',
        selfFixSteps: ['Sprawdź podstawowe przyczyny', 'Wyłącz zasilanie jeśli dotyczy', 'Skontaktuj się z fachowcem'],
        recommendedMode: 'flexible',
        priceRange: { min: 100, max: 500 }
      };
    }
    
    res.json(triageResult);
  } catch (error) {
    logger.error('AI_TRIAGE_ERROR:', {
      message: error.message,
      stack: error.stack,
      description: req.body?.description?.substring(0, 100)
    });
    res.status(500).json({ error: 'AI triage failed' });
  }
});

// Helper functions dla triage
function determineSeverity(description, aiResponse) {
  const desc = description.toLowerCase();
  if (desc.includes('awaria') || desc.includes('zalanie') || desc.includes('pożar') || desc.includes('zagrożenie')) {
    return 'urgent';
  }
  if (desc.includes('pilne') || desc.includes('szybko') || desc.includes('natychmiast')) {
    return 'high';
  }
  if (desc.includes('może poczekać') || desc.includes('niepilne')) {
    return 'low';
  }
  return 'medium';
}

function determineRecommendedMode(description, aiResponse) {
  const desc = description.toLowerCase();
  if (desc.includes('teraz') || desc.includes('natychmiast') || desc.includes('awaria')) {
    return 'now';
  }
  if (desc.includes('dziś') || desc.includes('dzisiaj') || desc.includes('jak najszybciej')) {
    return 'today';
  }
  return 'flexible';
}

module.exports = router;


