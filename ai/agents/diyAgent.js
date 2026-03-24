/**
 * Agent DIY
 * Bezpieczne instrukcje krok po kroku + STOP conditions
 */

const { DIY_SYSTEM } = require('../prompts/diyPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { validateDIYResponse } = require('../schemas/conciergeSchemas');
const { deriveSelfHelpSteps } = require('../../utils/concierge');
const { extractKeywords } = require('../utils/normalize');
const { enforceSafetyRules } = require('../utils/guardrails');

/**
 * Główna funkcja agenta DIY
 * @param {Object} params
 * @param {string} params.service - Kategoria usługi
 * @param {Array} params.messages - Historia konwersacji
 * @returns {Promise<Object>} Response agenta
 */
async function runDIYAgent({ service, messages }) {
  try {
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    const userText = (lastUserMessage?.content || lastUserMessage?.text || '').toLowerCase();
    
    // Sprawdź bezpieczeństwo - jeśli niebezpieczne, nie daj instrukcji DIY
    const keywords = extractKeywords(userText);
    const hasDanger = keywords.some(k => ['gas', 'fire', 'electricity'].includes(k));
    
    if (hasDanger) {
      return {
        ok: true,
        agent: 'diy',
        service: service || 'inne',
        difficulty: 'hard',
        estimatedTimeMinutes: 0,
        tools: [],
        steps: [],
        stopConditions: ['Problem niebezpieczny - nie rób sam'],
        fallback: {
          recommendProvider: true,
          reason: 'Ze względu na bezpieczeństwo, zalecamy kontakt z fachowcem'
        },
        missing: [],
        questions: [],
        safety: {
          flag: true,
          reason: 'Wykryto niebezpieczną sytuację',
          recommendation: 'Kontakt z fachowcem jest konieczny'
        }
      };
    }
    
    // Użyj istniejącej funkcji deriveSelfHelpSteps z utils/concierge
    const description = userText;
    const { steps: heuristicSteps, flags } = deriveSelfHelpSteps(description, 'pl');
    
    // Jeśli brak kroków z heurystyki, spróbuj LLM
    let steps = heuristicSteps.map(s => s.text || s);
    let difficulty = steps.length <= 3 ? 'easy' : steps.length <= 6 ? 'medium' : 'hard';
    
    if (steps.length === 0) {
      try {
        const systemPrompt = DIY_SYSTEM + `\n\nService: ${service || 'inne'}`;
        
        const llmResponse = await callAgentLLM({
          systemPrompt,
          messages,
          agentType: 'diy',
          context: { lang: 'pl' }
        });
        
        let parsed;
        if (typeof llmResponse === 'string') {
          parsed = safeParseJSON(llmResponse);
        } else if (typeof llmResponse === 'object' && llmResponse !== null) {
          parsed = llmResponse;
        }
        
        if (parsed && parsed.agent === 'diy' && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          steps = parsed.steps;
          difficulty = parsed.difficulty || difficulty;
        }
      } catch (llmError) {
        console.warn('LLM DIY failed, using heuristic:', llmError.message);
      }
    }
    
    // Jeśli nadal brak kroków, użyj podstawowych
    if (steps.length === 0) {
      steps = [
        'Opisz dokładnie problem (zdjęcie pomaga)',
        'Sprawdź oczywiste przyczyny (zasilanie, zawory)',
        'Jeśli problem nie rozwiązany - skontaktuj się z fachowcem'
      ];
    }
    
    // Określ narzędzia na podstawie usługi
    const tools = getToolsForService(service, userText);
    
    // Szacowany czas
    const estimatedTimeMinutes = estimateTime(difficulty, steps.length);
    
    // Warunki STOP
    const stopConditions = [
      'Jeśli problem się pogarsza',
      'Jeśli widzisz iskrzenie, dym, wyciek gazu',
      'Jeśli nie jesteś pewien co robisz',
      'Jeśli kroki nie pomagają'
    ];
    
    const result = {
      ok: true,
      agent: 'diy',
      service: service || 'inne',
      difficulty,
      estimatedTimeMinutes,
      tools,
      steps: steps.slice(0, 10), // Max 10 kroków
      stopConditions,
      fallback: {
        recommendProvider: true,
        reason: 'Jeśli kroki nie pomogły lub nie jesteś pewien, skontaktuj się z fachowcem'
      },
      missing: [],
      questions: [],
      safety: {
        flag: flags.length > 0,
        reason: flags.length > 0 ? `Wykryto flagi: ${flags.join(', ')}` : null,
        recommendation: flags.length > 0 
          ? 'Zalecamy ostrożność i kontakt z fachowcem jeśli nie jesteś pewien'
          : null
      }
    };
    
    validateDIYResponse(result);
    return result;
    
  } catch (error) {
    console.error('DIY Agent error:', error);
    
    // Fallback response
    return {
      ok: false,
      agent: 'diy',
      service: service || 'inne',
      difficulty: 'medium',
      estimatedTimeMinutes: 30,
      tools: [],
      steps: ['Opisz problem dokładniej', 'Sprawdź podstawowe przyczyny'],
      stopConditions: ['Jeśli problem się pogarsza'],
      fallback: {
        recommendProvider: true,
        reason: 'Skontaktuj się z fachowcem'
      },
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

function getToolsForService(service, userText) {
  const serviceLower = (service || '').toLowerCase();
  const tools = [];
  
  if (serviceLower.includes('hydraulik') || serviceLower.includes('woda')) {
    tools.push('Klucz');
    tools.push('Uszczelki');
    if (userText.includes('rur') || userText.includes('rura')) {
      tools.push('Klucz do rur');
    }
  }
  
  if (serviceLower.includes('elektryk') || serviceLower.includes('prąd')) {
    tools.push('Miernik napięcia');
    tools.push('Śrubokręt izolowany');
  }
  
  if (!tools.length) {
    tools.push('Podstawowe narzędzia');
    tools.push('Śrubokręt');
  }
  
  return tools;
}

function estimateTime(difficulty, stepsCount) {
  const baseTime = {
    easy: 15,
    medium: 30,
    hard: 60
  };
  
  return baseTime[difficulty] || 30 + (stepsCount * 5);
}

module.exports = {
  runDIYAgent
};

