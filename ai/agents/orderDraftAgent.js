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
    
    const service = normalizeServiceName(detectedService);
    if (!service || service === 'inne') {
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
    
    const description = buildDescription(userMessages, extracted).slice(0, 240);
    
    if (!description || description.length < 10) {
      missing.push('opis problemu');
      questions.push('Opisz dokładniej problem');
    }
    
    // Przygotuj payload zlecenia
    const orderPayload = {
      service,
      description: description.slice(0, 240),
      location: extracted.location?.text || extracted.location || null,
      status: 'draft',
      preferredTime: extracted.timeWindow || null,
      budget: extracted.budget || null,
      urgency: normalizeUrgency(urgency),
      attachments: extracted.attachments || []
    };

    const completion = calculateCompletion(orderPayload, missing);
    const quickReplies = buildQuickReplies(missing, extracted, urgency);
    
    return {
      ok: true,
      agent: 'order_draft',
      canCreate: missing.length === 0,
      orderPayload,
      missing,
      questions: questions.slice(0, 3),
      quickReplies,
      completion,
      summary: buildSummary(orderPayload, missing)
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

function buildDescription(userMessages, extracted = {}) {
  const details = Array.isArray(extracted.details) ? extracted.details.filter(Boolean) : [];
  const base = String(userMessages || '').trim();
  if (details.length === 0) return base;
  const detailText = details.join('; ');
  return base.includes(detailText) ? base : `${base}. Szczegóły: ${detailText}`;
}

function calculateCompletion(orderPayload, missing = []) {
  const fields = [
    orderPayload.service && orderPayload.service !== 'inne',
    orderPayload.description && orderPayload.description.length >= 10,
    !!orderPayload.location,
    !!orderPayload.preferredTime,
    !!orderPayload.urgency
  ];
  const done = fields.filter(Boolean).length;
  return {
    percent: Math.round((done / fields.length) * 100),
    ready: missing.length === 0,
    filled: done,
    total: fields.length
  };
}

function buildQuickReplies(missing = [], extracted = {}, urgency = 'standard') {
  const replies = [];
  if (missing.includes('lokalizacja')) {
    replies.push(
      { label: 'Podam miasto', value: 'Potrzebuję pomocy w ' },
      { label: 'Użyj mojej lokalizacji', value: 'Chcę użyć mojej aktualnej lokalizacji' }
    );
  }
  if (!extracted.timeWindow) {
    replies.push(
      { label: 'Dziś', value: 'Potrzebuję pomocy dzisiaj' },
      { label: 'Jutro', value: 'Może być jutro' },
      { label: 'Może poczekać', value: 'To nie jest pilne, może poczekać kilka dni' }
    );
  }
  if (!extracted.budget && urgency !== 'urgent') {
    replies.push({ label: 'Pokaż widełki', value: 'Ile to może kosztować?' });
  }
  replies.push({ label: 'Dodam zdjęcie', value: 'Dodam zdjęcie problemu' });
  return replies.slice(0, 6);
}

function buildSummary(orderPayload, missing = []) {
  return {
    title: orderPayload.service && orderPayload.service !== 'inne' ? 'Draft zlecenia' : 'Draft do uzupełnienia',
    service: orderPayload.service || 'Nie rozpoznano',
    description: orderPayload.description || 'Brak opisu',
    location: orderPayload.location || 'Brak lokalizacji',
    preferredTime: orderPayload.preferredTime || 'Do ustalenia',
    urgency: orderPayload.urgency || 'standard',
    budget: orderPayload.budget || null,
    missing
  };
}

module.exports = {
  runOrderDraftAgent
};

