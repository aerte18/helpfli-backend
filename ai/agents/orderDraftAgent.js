/**
 * Agent Order Draft
 * Z rozmowy → payload do utworzenia zlecenia
 */

const { ORDER_DRAFT_SYSTEM } = require('../prompts/orderDraftPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { validateOrderDraftResponse } = require('../schemas/conciergeSchemas');
const { normalizeUrgency, normalizeServiceName } = require('../utils/normalize');
const { evaluateOrderDraftPreflight } = require('../utils/preflightQualityEvaluator');

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
    const nextPrompt = pickNextPrompt(missing, extracted, orderPayload);
    const quickReplies = buildQuickReplies(nextPrompt, urgency);
    const providerBrief = buildProviderBrief(orderPayload, extracted, missing);
    const quality = await evaluateOrderDraftPreflight({ orderPayload, extracted, missing });
    const contextSnapshot = buildContextSnapshot(orderPayload, extracted, userMessages);
    
    return {
      ok: true,
      agent: 'order_draft',
      canCreate: missing.length === 0,
      orderPayload,
      missing,
      optionalMissing: buildOptionalMissing(extracted, orderPayload),
      questions: nextPrompt?.question ? [nextPrompt.question] : questions.slice(0, 1),
      nextQuestion: nextPrompt?.question || null,
      nextField: nextPrompt?.field || null,
      quickReplies,
      completion,
      quality,
      providerBrief,
      contextSnapshot,
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

function pickNextPrompt(missing = [], extracted = {}, orderPayload = {}) {
  if (missing.includes('kategoria usługi')) {
    return {
      field: 'service',
      question: 'Jaka usługa jest potrzebna?'
    };
  }
  if (missing.includes('opis problemu')) {
    return {
      field: 'description',
      question: 'Opisz proszę krótko, co dokładnie nie działa.'
    };
  }
  if (missing.includes('lokalizacja')) {
    return {
      field: 'location',
      question: 'W jakiej lokalizacji potrzebujesz pomocy?'
    };
  }
  if (!extracted.timeWindow && !orderPayload.preferredTime) {
    return {
      field: 'timeWindow',
      question: 'Kiedy wykonawca ma przyjechać: dziś, jutro czy termin jest elastyczny?'
    };
  }
  if (!extracted.budget && !orderPayload.budget) {
    return {
      field: 'budget',
      question: 'Czy masz budżet, czy mam pokazać orientacyjne widełki?'
    };
  }
  return {
    field: 'confirmation',
    question: 'Mam komplet do przygotowania zlecenia. Potwierdzasz utworzenie?'
  };
}

function buildOptionalMissing(extracted = {}, orderPayload = {}) {
  const optional = [];
  if (!extracted.timeWindow && !orderPayload.preferredTime) optional.push('termin');
  if (!extracted.budget && !orderPayload.budget) optional.push('budżet');
  return optional;
}

function buildQuickReplies(nextPrompt, urgency = 'standard') {
  if (!nextPrompt) return [];
  if (nextPrompt.field === 'location') {
    return [
      { label: 'Podam miasto', value: 'Potrzebuję pomocy w ' },
      { label: 'Użyj mojej lokalizacji', value: 'Chcę użyć mojej aktualnej lokalizacji' }
    ];
  }
  if (nextPrompt.field === 'timeWindow') {
    return [
      { label: 'Dziś', value: 'Potrzebuję pomocy dzisiaj' },
      { label: 'Jutro', value: 'Może być jutro' },
      { label: urgency === 'urgent' ? 'Jak najszybciej' : 'Może poczekać', value: urgency === 'urgent' ? 'Jak najszybciej' : 'To nie jest pilne, może poczekać kilka dni' }
    ];
  }
  if (nextPrompt.field === 'budget') {
    return [
      { label: 'Pokaż widełki', value: 'Ile to może kosztować?' },
      { label: 'Do 300 zł', value: 'Mój budżet to do 300 zł' },
      { label: 'Bez budżetu', value: 'Nie mam określonego budżetu' }
    ];
  }
  if (nextPrompt.field === 'confirmation') {
    return [
      { label: 'Tak, utwórz', value: 'Tak, utwórz zlecenie' },
      { label: 'Dodam zdjęcie', value: 'Dodam zdjęcie problemu' },
      { label: 'Zmień termin', value: 'Chcę zmienić termin' }
    ];
  }
  return [];
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

function buildProviderBrief(orderPayload = {}, extracted = {}, missing = []) {
  const details = Array.isArray(extracted.details) ? extracted.details.filter(Boolean) : [];
  const title = buildProviderTitle(orderPayload, details);
  const bullets = [
    orderPayload.description ? `Problem: ${orderPayload.description}` : null,
    orderPayload.location ? `Lokalizacja: ${orderPayload.location}` : null,
    orderPayload.preferredTime ? `Termin: ${orderPayload.preferredTime}` : 'Termin: do ustalenia',
    orderPayload.urgency === 'urgent' ? 'Pilność: pilne' : `Pilność: ${orderPayload.urgency || 'standard'}`
  ].filter(Boolean);

  return {
    title,
    customerSummary: [title, ...bullets].join('\n'),
    bullets,
    suggestedAttachments: suggestAttachments(orderPayload, extracted),
    questionsForProvider: buildProviderQuestions(orderPayload, extracted),
    missingForBetterOffers: missing.length > 0 ? missing : buildOptionalMissing(extracted, orderPayload)
  };
}

function buildContextSnapshot(orderPayload = {}, extracted = {}, userMessages = '') {
  const details = Array.isArray(extracted.details) ? extracted.details.filter(Boolean) : [];
  const facts = [
    orderPayload.service ? `Usługa: ${prettifyService(orderPayload.service)}` : null,
    orderPayload.location ? `Lokalizacja: ${orderPayload.location}` : null,
    orderPayload.preferredTime ? `Termin: ${orderPayload.preferredTime}` : null,
    orderPayload.budget ? `Budżet: ${orderPayload.budget}` : null,
    orderPayload.urgency ? `Pilność: ${orderPayload.urgency}` : null,
    ...details.slice(0, 4)
  ].filter(Boolean);

  return {
    originalProblem: String(userMessages || orderPayload.description || '').slice(0, 500),
    extractedFacts: Array.from(new Set(facts)).slice(0, 8),
    handoffNote: buildHandoffNote(orderPayload, extracted),
    lastUpdatedAt: new Date().toISOString()
  };
}

function buildHandoffNote(orderPayload = {}, extracted = {}) {
  const service = prettifyService(orderPayload.service);
  const location = orderPayload.location ? ` w lokalizacji: ${orderPayload.location}` : '';
  const time = orderPayload.preferredTime ? ` Termin: ${orderPayload.preferredTime}.` : '';
  const budget = orderPayload.budget ? ` Budżet klienta: ${orderPayload.budget}.` : '';
  const details = Array.isArray(extracted.details) && extracted.details.length
    ? ` Szczegóły z rozmowy: ${extracted.details.slice(0, 3).join('; ')}.`
    : '';
  return `${service}: klient opisał problem jako "${orderPayload.description || 'brak opisu'}"${location}.${time}${budget}${details}`.slice(0, 650);
}

function buildProviderTitle(orderPayload = {}, details = []) {
  const service = prettifyService(orderPayload.service);
  const firstDetail = details[0];
  if (firstDetail) return `${service}: ${firstDetail}`.slice(0, 90);
  if (orderPayload.description) return `${service}: ${orderPayload.description}`.slice(0, 90);
  return service;
}

function prettifyService(service = '') {
  const labels = {
    'agd-rtv-naprawa-agd': 'Naprawa AGD',
    'agd-rtv-naprawa-rtv': 'Naprawa RTV',
    hydraulik_naprawa: 'Hydraulik',
    elektryk_naprawa: 'Elektryk',
    zlota_raczka: 'Złota rączka',
    sprzatanie: 'Sprzątanie',
    remont: 'Remont'
  };
  return labels[service] || service || 'Zlecenie';
}

function suggestAttachments(orderPayload = {}, extracted = {}) {
  const text = `${orderPayload.description || ''} ${(extracted.details || []).join(' ')}`.toLowerCase();
  const suggestions = [];
  if (/(pralk|zmywark|lod[oó]wk|piekarnik|agd|rtv|kod błędu|kod bledu)/i.test(text)) {
    suggestions.push('Zdjęcie kodu błędu');
    suggestions.push('Zdjęcie tabliczki znamionowej z modelem');
  }
  if (/(wyciek|ciekn|zalewa|woda)/i.test(text)) {
    suggestions.push('Zdjęcie miejsca wycieku');
  }
  if (/(gniazd|bezpiecznik|iskr|prąd|prad|elektr)/i.test(text)) {
    suggestions.push('Zdjęcie miejsca awarii z bezpiecznej odległości');
  }
  if (suggestions.length === 0) suggestions.push('Zdjęcie problemu lub miejsca wykonania usługi');
  return Array.from(new Set(suggestions)).slice(0, 3);
}

function buildProviderQuestions(orderPayload = {}, extracted = {}) {
  const questions = [];
  const text = `${orderPayload.description || ''} ${(extracted.details || []).join(' ')}`.toLowerCase();
  if (/(pralk|zmywark|lod[oó]wk|piekarnik|agd)/i.test(text)) {
    questions.push('Jaka jest marka i model urządzenia?');
  }
  if (!orderPayload.preferredTime) questions.push('Kiedy wykonawca może przyjechać?');
  if (!orderPayload.budget) questions.push('Czy klient ma orientacyjny budżet?');
  return questions.slice(0, 3);
}

module.exports = {
  runOrderDraftAgent
};

