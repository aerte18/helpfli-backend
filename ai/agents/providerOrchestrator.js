/**
 * Provider Orchestrator Agent
 * Klasyfikuje intencję providera i routuje do odpowiednich agentów
 */

const { PROVIDER_SYSTEM } = require('../prompts/providerPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { normalizeUrgency } = require('../utils/normalize');

/**
 * Główna funkcja orchestratora dla providerów
 */
async function runProviderOrchestrator({ messages, orderContext = {}, providerInfo = {}, assistantMode = 'offer' }) {
  try {
    const lastMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    const userText = (lastMessage?.content || lastMessage?.text || '').toLowerCase();
    
    // Heurystyczna klasyfikacja intencji
    const modeIntent = modeToIntent(assistantMode);
    let intent = modeIntent.intent;
    let nextStep = modeIntent.nextStep;
    let parsed = null;
    
    const wantsOffer = /(ofert|propozycj|wiadomo|napisz|przygotuj|wstaw)/i.test(userText);
    const wantsPrice = /(cena|cenę|wycen|ile|koszt|kwot)/i.test(userText);
    const wantsWin = /(wygra|szans|konkurenc|lepiej|skuteczn)/i.test(userText);
    const wantsQuestions = /(pytan|dopyta|zapyta|brakuje|doprecyz)/i.test(userText);

    if (assistantMode === 'company_pro') {
      intent = 'create_offer';
      nextStep = 'suggest_offer';
    } else if (assistantMode === 'pricing') {
      intent = 'pricing';
      nextStep = 'suggest_pricing';
    } else if (['risks', 'negotiation', 'followup'].includes(assistantMode)) {
      intent = 'communication';
      nextStep = 'communication_help';
    } else if (wantsOffer || wantsPrice || wantsWin || wantsQuestions) {
      if (wantsOffer || wantsWin || wantsQuestions) {
        intent = 'create_offer';
        nextStep = 'suggest_offer';
      } else {
        intent = 'pricing';
        nextStep = 'suggest_pricing';
      }
    } else if (userText.includes('komunikacja') || userText.includes('jak napisać') || userText.includes('odpowiedź')) {
      intent = 'communication';
      nextStep = 'communication_help';
    } else if (/najlepsze zlecenia|gdzie zarobić|dopasowane|szukam zleceń|pokaż zlecenia|znajdź zlecenia|które zlecenia|potencjał zarobku|otwarte zlecenia/.test(userText)) {
      intent = 'find_orders';
      nextStep = 'search_orders';
    }
    
    // Spróbuj użyć LLM dla lepszej klasyfikacji
    try {
      const systemPrompt = PROVIDER_SYSTEM + `\n\nProvider AI mode: ${assistantMode}\nOrder context: ${JSON.stringify(orderContext)}\nProvider info: ${JSON.stringify(providerInfo)}`;
      
      const llmResponse = await callAgentLLM({
        systemPrompt,
        messages,
        agentType: 'provider_orchestrator',
        context: { lang: 'pl' }
      });
      
      if (typeof llmResponse === 'string') {
        parsed = safeParseJSON(llmResponse);
      } else if (typeof llmResponse === 'object' && llmResponse !== null) {
        parsed = llmResponse;
      }
      
      if (parsed && parsed.agent === 'provider_orchestrator') {
        intent = parsed.intent || intent;
        nextStep = parsed.nextStep || nextStep;
      }
    } catch (llmError) {
      console.warn('LLM provider orchestrator failed, using heuristic:', llmError.message);
    }

    if (assistantMode === 'company_pro') {
      intent = 'create_offer';
      nextStep = 'suggest_offer';
    } else if (assistantMode === 'pricing') {
      intent = 'pricing';
      nextStep = 'suggest_pricing';
    } else if (['risks', 'negotiation', 'followup'].includes(assistantMode)) {
      intent = 'communication';
      nextStep = 'communication_help';
    }
    
    // Wyekstraktuj dane
    const extracted = {
      service: orderContext.service || null,
      budgetHint: orderContext.budget ? {
        min: orderContext.budget.min || 0,
        max: orderContext.budget.max || 0,
        currency: 'PLN'
      } : null,
      urgency: normalizeUrgency(orderContext.urgency || 'standard'),
      location: orderContext.location?.city || orderContext.location || null
    };
    
    const replies = {
      create_offer: 'Pomogę Ci stworzyć profesjonalną ofertę, żeby zwiększyć szansę na wygraną.',
      pricing: 'Pomogę Ci dobrać konkurencyjną cenę do tego zlecenia.',
      communication: 'Pokażę Ci, jak lepiej się komunikować z klientem.',
      find_orders: 'Sprawdzam zlecenia najlepiej dopasowane do Ciebie.',
      company_pro: 'Przygotuję ofertę w trybie firmowym PRO z naciskiem na SLA, formalny ton i wymagania firmy.',
      general: 'Jak mogę Ci pomóc przy tym zleceniu?'
    };
    const fallbackReply = replies[intent] || 'Jak mogę Ci pomóc?';
    const naturalReply = (typeof parsed?.reply === 'string' && parsed.reply.trim()) ? parsed.reply.trim() : null;
    
    return {
      ok: true,
      agent: 'provider_orchestrator',
      intent,
      nextStep,
      reply: naturalReply || fallbackReply,
      extracted,
      confidence: 0.8
    };
    
  } catch (error) {
    console.error('Provider Orchestrator error:', error);
    
    return {
      ok: false,
      agent: 'provider_orchestrator',
      intent: 'general',
      nextStep: 'general_help',
      reply: 'Przepraszam, wystąpił błąd. Spróbuj ponownie.',
      extracted: {},
      confidence: 0.0
    };
  }
}

function modeToIntent(mode = 'offer') {
  const map = {
    offer: { intent: 'create_offer', nextStep: 'suggest_offer' },
    company_pro: { intent: 'create_offer', nextStep: 'suggest_offer' },
    pricing: { intent: 'pricing', nextStep: 'suggest_pricing' },
    risks: { intent: 'communication', nextStep: 'communication_help' },
    negotiation: { intent: 'communication', nextStep: 'communication_help' },
    followup: { intent: 'communication', nextStep: 'communication_help' }
  };
  return map[mode] || map.offer;
}

module.exports = {
  runProviderOrchestrator
};

