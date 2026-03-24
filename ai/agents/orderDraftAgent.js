/**
 * Agent Order Draft
 * Z rozmowy → payload do utworzenia zlecenia
 */

const { ORDER_DRAFT_SYSTEM } = require('../prompts/orderDraftPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { validateOrderDraftResponse } = require('../schemas/conciergeSchemas');
const { normalizeUrgency, normalizeServiceName } = require('../utils/normalize');

/**
 * Główna funkcja agenta Order Draft
 * @param {Object} params
 * @param {Array} params.messages - Historia konwersacji
 * @param {Object} params.extracted - Wyekstraktowane dane (location, timeWindow, budget, etc.)
 * @param {string} params.detectedService - Wykryta kategoria usługi
 * @param {string} params.urgency - Pilność
 * @returns {Promise<Object>} Response agenta
 */
async function runOrderDraftAgent({ messages, extracted = {}, detectedService, urgency = 'standard' }) {
  try {
    // Sprawdź czy mamy wszystkie potrzebne dane
    const missing = [];
    const questions = [];
    
    if (!detectedService || detectedService === 'inne') {
      missing.push('kategoria usługi');
      questions.push('Jaka usługa jest potrzebna?');
    }
    
    if (!extracted.location && !extracted.location?.text) {
      missing.push('lokalizacja');
      questions.push('W jakiej lokalizacji potrzebujesz pomocy?');
    }
    
    // Wyekstraktuj description z rozmowy
    const userMessages = messages
      .filter(m => m.role === 'user')
      .map(m => m.content || m.text || '')
      .join(' ');
    
    const description = userMessages.trim().slice(0, 200); // Max 200 znaków
    
    if (!description || description.length < 10) {
      missing.push('opis problemu');
      questions.push('Opisz dokładniej problem');
    }
    
    // Jeśli brakuje danych, nie można utworzyć zlecenia
    if (missing.length > 0) {
      return {
        ok: true,
        agent: 'order_draft',
        canCreate: false,
        orderPayload: null,
        missing,
        questions: questions.slice(0, 3)
      };
    }
    
    // Przygotuj payload zlecenia
    const orderPayload = {
      service: normalizeServiceName(detectedService),
      description: description.slice(0, 200),
      location: extracted.location?.text || extracted.location || 'Nie podano',
      status: 'draft',
      preferredTime: extracted.timeWindow || null,
      budget: extracted.budget || null,
      urgency: normalizeUrgency(urgency),
      attachments: extracted.attachments || []
    };
    
    return {
      ok: true,
      agent: 'order_draft',
      canCreate: true,
      orderPayload,
      missing: [],
      questions: []
    };
    
  } catch (error) {
    console.error('Order Draft Agent error:', error);
    
    return {
      ok: false,
      agent: 'order_draft',
      canCreate: false,
      orderPayload: null,
      missing: ['Nie udało się przygotować zlecenia'],
      questions: ['Czy możesz opisać problem dokładniej?']
    };
  }
}

module.exports = {
  runOrderDraftAgent
};

