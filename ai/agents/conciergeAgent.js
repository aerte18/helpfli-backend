/**
 * Agent Concierge (Orchestrator)
 * Klasyfikuje intencję, dopasowuje usługę, określa pilność, decyduje o nextStep
 */

const { CONCIERGE_SYSTEM } = require('../prompts/conciergePrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { guardrailEnforce, enforceSafetyRules } = require('../utils/guardrails');
const { validateConciergeResponseShape } = require('../schemas/conciergeSchemas');
const { normalizeServiceName, normalizeUrgency, extractKeywords } = require('../utils/normalize');
const { detectApplianceIssue } = require('../utils/applianceDiagnostics');

/**
 * Główna funkcja agenta Concierge
 * @param {Object} params
 * @param {Array} params.messages - Historia konwersacji
 * @param {Object} params.userContext - Kontekst użytkownika (location, userId, etc.)
 * @param {Array} params.allowedServicesHint - Lista dostępnych usług (opcjonalnie)
 * @returns {Promise<Object>} Response agenta
 */
async function runConciergeAgent({ messages, userContext = {}, allowedServicesHint = [] }) {
  try {
    // Jeśli nie ma podanych usług, pobierz je z bazy (opcjonalnie, dla lepszej klasyfikacji)
    let services = allowedServicesHint;
    if (services.length === 0) {
      try {
        const Service = require('../../models/Service');
        const allServices = await Service.find({}).select('code name').lean();
        services = allServices.map(s => s.code || s.name).filter(Boolean);
      } catch (err) {
        console.warn('Could not load services from DB, using default list');
        services = ['hydraulik_naprawa', 'elektryk_naprawa', 'zlota_raczka', 'sprzatanie', 'remont', 'inne'];
      }
    }
    
    // Przygotuj prompt z kontekstem i personalizacją
    let systemPrompt = buildConciergePrompt({
      allowedServices: services,
      userLocation: userContext.location?.text || userContext.location || null,
      userProfile: userContext.userProfile || null // Faza 3 - personalizacja
    });

    // A/B Testing - dostosuj prompt do wariantu (Faza 3)
    // Uwaga: abVariants powinny być przekazane przez userContext
    if (userContext.abVariants) {
      const abTestingService = require('../../services/ABTestingService');
      const responseLengthConfig = abTestingService.getVariantConfig('response_length', userContext.abVariants.responseLength);
      if (responseLengthConfig) {
        if (responseLengthConfig.name === 'Brief') {
          systemPrompt += '\n\nWAŻNE: Odpowiadaj bardzo zwięźle, maksymalnie 1-2 zdania.';
        } else if (responseLengthConfig.name === 'Detailed') {
          systemPrompt += '\n\nWAŻNE: Odpowiadaj szczegółowo, wyjaśniaj kontekst, podawaj przykłady.';
        }
      }
    }

    // Wywołaj LLM (z tool calling dla listy zleceń, przedłuż, anuluj)
    const enableTools = true;
    const llmResponse = await callAgentLLM({
      systemPrompt,
      messages,
      agentType: 'concierge',
      enableTools: enableTools,
      context: {
        lang: 'pl',
        locationText: userContext.location?.text || userContext.location || null,
        lat: userContext.location?.lat || userContext.lat,
        lng: userContext.location?.lng || userContext.lng,
        userId: userContext.userId // Dla tool calling
      }
    });
    
    // Jeśli LLM użył narzędzia i zwrócił tool_result
    if (llmResponse && llmResponse.type === 'tool_result') {
      return {
        ok: true,
        agent: 'concierge',
        reply: llmResponse.response || `Wykonano akcję: ${llmResponse.toolUsed}`,
        toolUsed: llmResponse.toolUsed,
        toolResult: llmResponse.toolResult,
        nextStep: llmResponse.toolUsed === 'createOrder' ? 'order_created' : 'ask_more',
        confidence: 0.9
      };
    }

    // Odpowiedź tekstowa po użyciu narzędzia (np. lista zleceń, przedłuż, anuluj)
    if (llmResponse && llmResponse.type === 'text' && llmResponse.response && llmResponse.toolUsed) {
      return {
        ok: true,
        agent: 'concierge',
        reply: llmResponse.response,
        toolUsed: llmResponse.toolUsed || null,
        toolResult: llmResponse.toolResult || null,
        nextStep: 'ask_more',
        intent: 'other',
        detectedService: 'inne',
        urgency: 'standard',
        confidence: 0.9,
        extracted: { location: null, timeWindow: null, budget: null, details: [] },
        questions: []
      };
    }

    // Parsuj odpowiedź (może być już obiektem lub stringiem JSON)
    let parsed;
    if (typeof llmResponse === 'string') {
      parsed = safeParseJSON(llmResponse);
    } else if (typeof llmResponse === 'object' && llmResponse !== null) {
      // Gdy z tool calling zwrócono tekst (JSON) bez toolUsed – parsuj response
      if (llmResponse.type === 'text' && typeof llmResponse.response === 'string') {
        parsed = safeParseJSON(llmResponse.response);
      }
      if (!parsed) {
        parsed = mapLLMResponseToConciergeFormat(llmResponse, messages);
      }
    } else {
      throw new Error('Invalid LLM response format');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Failed to parse LLM response as JSON');
    }

    // Wymuś podstawowe pola
    if (!parsed.agent) parsed.agent = 'concierge';
    if (!parsed.ok) parsed.ok = true;

    // Wykryj słowa kluczowe dla bezpieczeństwa
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    const userText = lastUserMessage?.content || lastUserMessage?.text || '';
    const applianceIssue = detectApplianceIssue(userText);
    parsed = enforceSafetyRules(parsed, userText);

    // Normalizuj i waliduj
    parsed = guardrailEnforce(parsed);
    validateConciergeResponseShape(parsed);

    // Normalizacja dodatkowych pól
    parsed.detectedService = normalizeServiceName(parsed.detectedService);
    parsed.urgency = normalizeUrgency(parsed.urgency);

    if (applianceIssue && (parsed.detectedService === 'inne' || parsed.confidence < applianceIssue.confidence || applianceIssue.code)) {
      parsed.detectedService = applianceIssue.service;
      parsed.intent = 'service_request';
      parsed.urgency = applianceIssue.urgency;
      parsed.nextStep = applianceIssue.nextStep;
      parsed.confidence = Math.max(parsed.confidence || 0, applianceIssue.confidence);
      parsed.reply = applianceIssue.reply;
      parsed.questions = applianceIssue.questions;
      parsed.safety = applianceIssue.safety.flag ? applianceIssue.safety : parsed.safety;
    }

    // Jeśli nie ma extracted, stwórz z kontekstu
    if (!parsed.extracted || typeof parsed.extracted !== 'object') {
      parsed.extracted = {
        location: userContext.location?.text || userContext.location || null,
        timeWindow: null,
        budget: null,
        details: []
      };
    }
    if (applianceIssue) {
      parsed.extracted.details = Array.from(new Set([
        ...(parsed.extracted.details || []),
        ...applianceIssue.details
      ].filter(Boolean)));
    }

    // Wyekstraktuj keywords dla dodatkowej analizy
    if (userText) {
      const keywords = extractKeywords(userText);
      if (keywords.length > 0 && !parsed.extracted.details) {
        parsed.extracted.details = [];
      }
    }

    return parsed;

  } catch (error) {
    console.error('❌ Concierge Agent error:', error);
    console.error('Error stack:', error.stack);
    console.error('Error message:', error.message);
    
    // Ukryj szczegóły błędów przed użytkownikiem - szczególnie błędy autoryzacji
    const isAuthError = error.message?.includes('401') || 
                       error.message?.includes('authentication') ||
                       error.message?.includes('invalid x-api-key');
    
    const userFriendlyMessage = isAuthError
      ? 'Przepraszam, wystąpił problem z konfiguracją AI. Używam alternatywnego systemu analizy. Spróbuj ponownie opisać problem.'
      : 'Przepraszam, wystąpił błąd podczas przetwarzania. Spróbuj ponownie opisać problem.';
    
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    const userText = lastUserMessage?.content || lastUserMessage?.text || '';
    const applianceIssue = detectApplianceIssue(userText);

    if (applianceIssue) {
      return {
        ok: true,
        agent: 'concierge',
        reply: applianceIssue.reply,
        intent: 'service_request',
        detectedService: applianceIssue.service,
        urgency: applianceIssue.urgency,
        confidence: applianceIssue.confidence,
        nextStep: applianceIssue.nextStep,
        questions: applianceIssue.questions,
        extracted: {
          location: userContext.location?.text || userContext.location || null,
          timeWindow: null,
          budget: null,
          details: applianceIssue.details
        },
        missing: applianceIssue.questions,
        safety: applianceIssue.safety
      };
    }

    // Fallback response z przyjaznym komunikatem dla użytkownika
    return {
      ok: false,
      agent: 'concierge',
      reply: userFriendlyMessage,
      intent: 'other',
      detectedService: 'inne',
      urgency: 'standard',
      confidence: 0.3,
      nextStep: 'ask_more',
      questions: ['Czy możesz opisać problem dokładniej?'],
      extracted: {
        location: null,
        timeWindow: null,
        budget: null,
        details: []
      },
      missing: [],
      safety: {
        flag: false,
        reason: null,
        recommendation: null
      }
      // Usunięte error: error.message - nie pokazujemy szczegółów użytkownikowi
    };
  }
}

/**
 * Buduje prompt dla agenta Concierge z kontekstem
 */
function buildConciergePrompt({ allowedServices = [], userLocation = null, userProfile = null }) {
  let prompt = CONCIERGE_SYSTEM;
  
  if (allowedServices.length > 0) {
    prompt += `\n\nDostępne kategorie usług: ${allowedServices.join(', ')}`;
  }
  
  if (userLocation) {
    prompt += `\n\nLokalizacja użytkownika: ${userLocation}`;
  }

  // Personalizacja (Faza 3)
  if (userProfile) {
    const PersonalizationService = require('../../services/PersonalizationService');
    prompt = PersonalizationService.personalizePrompt(prompt, userProfile);
  }
  
  return prompt;
}

/**
 * Mapuje odpowiedź z llm_service na format agenta Concierge
 * Backward compatibility - pozwala używać obecnego llm_service
 */
function mapLLMResponseToConciergeFormat(llmResponse, messages) {
  const lastUserMessage = messages
    .filter(m => m.role === 'user')
    .pop();
  const userText = lastUserMessage?.content || lastUserMessage?.text || '';

  // Mapuj serviceCandidate
  const serviceCode = llmResponse.serviceCandidate?.code || 'inne';
  const serviceName = llmResponse.serviceCandidate?.name || 'Inne';

  // Określ intencję na podstawie kontekstu
  const textLower = userText.toLowerCase();
  let intent = 'service_request';
  if (textLower.includes('cen') || textLower.includes('koszt') || textLower.includes('ile')) {
    intent = 'pricing';
  } else if (textLower.includes('wykonawc') || textLower.includes('fachowc') || textLower.includes('znajdź')) {
    intent = 'providers';
  } else if (textLower.includes('sam') || textLower.includes('diy') || textLower.includes('zrób')) {
    intent = 'diy';
  }

  // Określ nextStep na podstawie dostępnych danych
  let nextStep = 'ask_more';
  if (llmResponse.serviceCandidate && userText.length > 10) {
    if (llmResponse.dangerFlags && llmResponse.dangerFlags.length > 0) {
      nextStep = 'diagnose';
    } else if (llmResponse.diySteps && llmResponse.diySteps.length > 0) {
      nextStep = 'suggest_diy';
    } else {
      nextStep = 'suggest_providers';
    }
  }

  // Określ pilność
  let urgency = normalizeUrgency(llmResponse.urgency || 'standard');
  if (llmResponse.dangerFlags && llmResponse.dangerFlags.length > 0) {
    urgency = 'urgent';
  }

  // Stwórz naturalną odpowiedź
  let reply = `Rozumiem Twój problem związany z ${serviceName}. `;
  
  if (llmResponse.dangerFlags && llmResponse.dangerFlags.length > 0) {
    reply += `⚠️ Wykryłem potencjalne zagrożenie - zalecam ostrożność. `;
  }
  
  if (llmResponse.diySteps && llmResponse.diySteps.length > 0) {
    reply += `Mogę zaproponować ${llmResponse.diySteps.length} kroków do wykonania samodzielnie. `;
  } else {
    reply += `Mogę pomóc znaleźć fachowca w Twojej okolicy. `;
  }

  // Pytania doprecyzowujące
  const questions = [];
  if (!llmResponse.locationText) {
    questions.push('W jakiej lokalizacji potrzebujesz pomocy?');
  }
  if (!llmResponse.urgency || urgency === 'standard') {
    questions.push('Kiedy potrzebujesz pomocy? (dziś, jutro, może poczekać)');
  }

  return {
    ok: true,
    agent: 'concierge',
    reply,
    intent,
    detectedService: serviceCode,
    urgency,
    confidence: llmResponse.serviceCandidate?.confidence || 0.7,
    nextStep,
    questions: questions.slice(0, 3),
    extracted: {
      location: llmResponse.locationText || null,
      timeWindow: null,
      budget: llmResponse.estimatedCost || null,
      details: []
    },
    missing: questions.map(q => q.replace('?', '')),
    safety: {
      flag: (llmResponse.dangerFlags && llmResponse.dangerFlags.length > 0) || false,
      reason: llmResponse.dangerFlags?.[0] || null,
      recommendation: llmResponse.dangerFlags?.length > 0 
        ? 'Zalecamy kontakt z fachowcem ze względu na bezpieczeństwo' 
        : null
    }
  };
}

module.exports = {
  runConciergeAgent,
  buildConciergePrompt // Export dla streaming endpoint
};

