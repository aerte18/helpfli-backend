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
    let userText = (lastMessage?.content || lastMessage?.text || '').toLowerCase();

    const userMsgs = messages.filter((m) => m.role === 'user');
    if (/^(jak|co dalej|a jak|jak to)\??$/i.test(userText.trim()) && userMsgs.length >= 2) {
      const prev = (userMsgs[userMsgs.length - 2].content || userMsgs[userMsgs.length - 2].text || '').toLowerCase();
      userText = `${prev} ${userText}`.trim();
    }

    // Heurystyczna klasyfikacja intencji
    const modeIntent = modeToIntent(assistantMode);
    let intent = modeIntent.intent;
    let nextStep = modeIntent.nextStep;
    let parsed = null;
    const heuristicLocked = { value: false };

    const wantsFindOrders =
      /najlepsz(e|y|a)?\s+(zlecen|ofert)|pokaż\s+(zlecen|ofert)|znajd[źz]\s+(zlecen|ofert)|szukam\s+(zlecen|ofert)|otwarte\s+zlecen|dopasowane\s+zlecen|gdzie\s+zarobi|potencjał\s+zarobku|czy\s+są\s+(jakieś\s+)?(zlecen|ofert)|oferty?\s+(z|dla)\s+(agd|hydraul|elektr|remont)/i.test(
        userText
      );
    const wantsOffer = /(napisz|przygotuj|stwórz|wstaw).{0,24}(ofert|propozycj)|profesjonaln[aą]\s+ofert/i.test(userText);
    const wantsPrice = /(cena|cenę|wycen|ile\s+koszt|koszt|kwot)/i.test(userText);
    const wantsCoaching =
      /(efektywno|skuteczno|wyboru?\s+ofert|jak\s+(zwiększy|poprawić|lepiej|wybierać)|poprawić\s+(skuteczno|efektywno)|lepsze\s+oferty)/i.test(
        userText
      );
    const wantsWin = /(wygra|szans[aę]\s+na|konkurenc)/i.test(userText);
    const wantsQuestions = /(pytan|dopyta|zapyta|brakuje|doprecyz)/i.test(userText);

    if (wantsFindOrders) {
      intent = 'find_orders';
      nextStep = 'search_orders';
      heuristicLocked.value = true;
    } else if (wantsCoaching && !wantsOffer) {
      intent = 'communication';
      nextStep = 'communication_help';
      heuristicLocked.value = true;
    } else if (assistantMode === 'company_pro') {
      intent = 'create_offer';
      nextStep = 'suggest_offer';
    } else if (assistantMode === 'pricing') {
      intent = 'pricing';
      nextStep = 'suggest_pricing';
    } else if (['risks', 'negotiation', 'followup'].includes(assistantMode)) {
      intent = 'communication';
      nextStep = 'communication_help';
    } else if ((wantsWin || wantsCoaching) && !wantsOffer) {
      intent = 'communication';
      nextStep = 'communication_help';
      heuristicLocked.value = true;
    } else if (wantsOffer || wantsQuestions) {
      intent = 'create_offer';
      nextStep = 'suggest_offer';
    } else if (wantsPrice) {
      intent = 'pricing';
      nextStep = 'suggest_pricing';
    } else if (userText.includes('komunikacja') || userText.includes('jak napisać') || userText.includes('odpowiedź')) {
      intent = 'communication';
      nextStep = 'communication_help';
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
      
      if (parsed && parsed.agent === 'provider_orchestrator' && !heuristicLocked.value) {
        intent = parsed.intent || intent;
        nextStep = parsed.nextStep || nextStep;
      }
    } catch (llmError) {
      console.warn('LLM provider orchestrator failed, using heuristic:', llmError.message);
    }

    if (!heuristicLocked.value) {
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
      communication: 'Podpowiem, jak pisać oferty i komunikować się skuteczniej z klientem.',
      find_orders: 'Sprawdzam zlecenia najlepiej dopasowane do Ciebie — chwilę…',
      company_pro: 'Przygotuję ofertę w trybie firmowym PRO z naciskiem na SLA, formalny ton i wymagania firmy.',
      general: 'Jak mogę Ci pomóc przy tym zleceniu?'
    };
    const coachingReply =
      'Kilka sprawdzonych sposobów na skuteczniejsze oferty:\n' +
      '• Zacznij od 1–2 zdań o problemie klienta (pokaż, że czytałeś zlecenie).\n' +
      '• Podaj konkretną cenę lub widełki i realny termin — bez „do uzgodnienia”.\n' +
      '• Wypisz zakres prac punktami (co wchodzi, co nie).\n' +
      '• Odpowiadaj w ciągu kilku godzin — szybkość podnosi szanse na wybór.\n' +
      '• Jeśli możesz, dodaj zdjęcie z podobnej realizacji.\n\n' +
      'Chcesz listę dopasowanych zleceń? Napisz: „pokaż najlepsze zlecenia”.';

    let fallbackReply = replies[intent] || 'Jak mogę Ci pomóc?';
    if (intent === 'communication' && (wantsCoaching || wantsWin) && !parsed?.reply) {
      fallbackReply = coachingReply;
    }
    const genericOfferLine = /pomogę ci stworzyć profesjonalną ofertę/i;
    let naturalReply =
      typeof parsed?.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : null;
    if (naturalReply && genericOfferLine.test(naturalReply) && ['communication', 'find_orders'].includes(intent)) {
      naturalReply = null;
    }
    if (intent === 'communication' && (wantsCoaching || wantsWin) && !naturalReply) {
      fallbackReply = coachingReply;
    }
    
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

