/**
 * Agent Diagnostyczny
 * Ocena ryzyka, pilności, rekomendacja ścieżki (express/provider/diy/teleconsult)
 */

const { DIAGNOSTIC_SYSTEM } = require('../prompts/diagnosticPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { validateDiagnosticResponse } = require('../schemas/conciergeSchemas');
const { normalizeUrgency, extractKeywords } = require('../utils/normalize');
const { guardrailEnforce, enforceSafetyRules } = require('../utils/guardrails');
const { detectSafetyTriage } = require('../utils/safetyTriage');

/**
 * Główna funkcja agenta Diagnostycznego
 * @param {Object} params
 * @param {Array} params.messages - Historia konwersacji
 * @param {string} params.detectedService - Wykryta kategoria usługi
 * @param {Object} params.userContext - Kontekst użytkownika (location, etc.)
 * @returns {Promise<Object>} Response agenta
 */
async function runDiagnosticAgent({ messages, detectedService, userContext = {} }) {
  try {
    // Najpierw użyj heurystyki na podstawie słów kluczowych (szybkie)
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    const userText = (lastUserMessage?.content || lastUserMessage?.text || '').toLowerCase();
    
    const keywords = extractKeywords(userText);
    const safetyTriage = detectSafetyTriage(userText);
    if (safetyTriage.flag) {
      return {
        ok: true,
        agent: 'diagnostic',
        urgency: ['critical', 'high'].includes(safetyTriage.level) ? 'urgent' : 'standard',
        risk: safetyTriage.level === 'critical' ? 'high' : safetyTriage.level,
        recommendedPath: safetyTriage.blockDIY ? 'express' : 'provider',
        rationale: [safetyTriage.reason],
        immediateActions: safetyTriage.actions,
        missing: [],
        questions: [],
        safety: safetyTriage
      };
    }
    const heuristicResult = runHeuristicDiagnostic(userText, keywords, detectedService);
    
    // Jeśli wykryto wysokie ryzyko, zwróć od razu (bez LLM)
    if (heuristicResult.risk === 'high' || heuristicResult.urgency === 'urgent') {
      return heuristicResult;
    }
    
    // Dla innych przypadków, spróbuj użyć LLM jeśli dostępny
    try {
      const systemPrompt = DIAGNOSTIC_SYSTEM + `\n\nDetected service: ${detectedService || 'unknown'}`;
      
      const llmResponse = await callAgentLLM({
        systemPrompt,
        messages,
        agentType: 'diagnostic',
        context: {
          lang: 'pl',
          locationText: userContext.location?.text || userContext.location || null
        }
      });
      
      // Parsuj odpowiedź
      let parsed;
      if (typeof llmResponse === 'string') {
        parsed = safeParseJSON(llmResponse);
      } else if (typeof llmResponse === 'object' && llmResponse !== null) {
        parsed = llmResponse;
      }
      
      if (parsed && parsed.agent === 'diagnostic') {
        // Waliduj i zwróć
        parsed = guardrailEnforce(parsed);
        validateDiagnosticResponse(parsed);
        parsed.urgency = normalizeUrgency(parsed.urgency);
        
        // Wykryj bezpieczeństwo
        parsed = enforceSafetyRules(parsed, userText);
        
        return parsed;
      }
    } catch (llmError) {
      console.warn('LLM diagnostic failed, using heuristic:', llmError.message);
    }
    
    // Fallback do heurystyki
    return heuristicResult;
    
  } catch (error) {
    console.error('Diagnostic Agent error:', error);
    
    // Fallback response
    return {
      ok: false,
      agent: 'diagnostic',
      urgency: 'standard',
      risk: 'none',
      recommendedPath: 'provider',
      rationale: ['Nie udało się ocenić problemu automatycznie'],
      immediateActions: [],
      missing: [],
      questions: ['Czy możesz opisać problem dokładniej?'],
      safety: {
        flag: false,
        reason: null,
        recommendation: null
      }
    };
  }
}

/**
 * Heurystyczna ocena diagnostyczna (bez LLM)
 */
function runHeuristicDiagnostic(userText, keywords, detectedService) {
  let urgency = 'standard';
  let risk = 'none';
  let recommendedPath = 'provider';
  const rationale = [];
  const immediateActions = [];
  const safetyFlags = [];
  
  // Wykryj wysokie ryzyko
  if (keywords.includes('gas')) {
    risk = 'high';
    urgency = 'urgent';
    recommendedPath = 'express';
    rationale.push('Wykryto potencjalne zagrożenie gazowe');
    immediateActions.push('Zakręć kurek gazu');
    immediateActions.push('Wywietrz pomieszczenie');
    immediateActions.push('Nie używaj urządzeń iskrzących');
    safetyFlags.push('gas');
  }
  
  if (keywords.includes('fire')) {
    risk = 'high';
    urgency = 'urgent';
    recommendedPath = 'express';
    rationale.push('Wykryto zagrożenie pożarowe');
    immediateActions.push('Zadzwoń na 112');
    immediateActions.push('Jeśli bezpieczne - użyj gaśnicy');
    safetyFlags.push('fire');
  }
  
  if (keywords.includes('electricity')) {
    risk = 'high';
    urgency = 'urgent';
    recommendedPath = 'express';
    rationale.push('Wykryto zagrożenie elektryczne');
    immediateActions.push('Wyłącz główne zasilanie');
    immediateActions.push('Nie dotykaj niczego');
    safetyFlags.push('electricity');
  }
  
  if (keywords.includes('water') && (userText.includes('zalanie') || userText.includes('zalewa'))) {
    risk = 'medium';
    urgency = 'urgent';
    recommendedPath = 'express';
    rationale.push('Wykryto poważny wyciek wody');
    immediateActions.push('Odetnij dopływ wody');
    safetyFlags.push('water');
  }
  
  // Określ pilność na podstawie kontekstu
  if (keywords.includes('urgent') || userText.includes('pilne') || userText.includes('teraz')) {
    urgency = 'urgent';
    if (recommendedPath === 'provider') {
      recommendedPath = 'express';
    }
  }
  
  // Określ recommendedPath na podstawie usługi i kontekstu
  if (risk === 'none' && urgency === 'low') {
    const simpleProblems = ['cieknie', 'kapie', 'luźny', 'prosty'];
    if (simpleProblems.some(p => userText.includes(p))) {
      recommendedPath = 'diy';
      rationale.push('Prosty problem - można spróbować samodzielnie');
    }
  }
  
  // Jeśli to porada/konsultacja, nie naprawa
  if (userText.includes('porada') || userText.includes('konsultacja') || userText.includes('doradź')) {
    recommendedPath = 'teleconsult';
    rationale.push('Potrzebna konsultacja, nie fizyczna naprawa');
  }
  
  return {
    ok: true,
    agent: 'diagnostic',
    urgency,
    risk,
    recommendedPath,
    rationale: rationale.length > 0 ? rationale : ['Standardowa ocena problemu'],
    immediateActions: immediateActions.slice(0, 4),
    missing: [],
    questions: [],
    safety: {
      flag: safetyFlags.length > 0,
      reason: safetyFlags.length > 0 ? `Wykryto zagrożenia: ${safetyFlags.join(', ')}` : null,
      recommendation: safetyFlags.length > 0 
        ? 'Zalecamy natychmiastowy kontakt z odpowiednimi służbami lub fachowcem'
        : null
    }
  };
}

module.exports = {
  runDiagnosticAgent
};

