const MAX_SESSIONS = 500;
const TTL_MS = 1000 * 60 * 60 * 6;

const drafts = new Map();

function getDraft(sessionId) {
  if (!sessionId) return null;
  const entry = drafts.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TTL_MS) {
    drafts.delete(sessionId);
    return null;
  }
  return entry.draft;
}

function saveDraft(sessionId, draft) {
  if (!sessionId || !draft) return draft;
  drafts.set(sessionId, {
    draft,
    updatedAt: Date.now()
  });
  pruneDrafts();
  return draft;
}

function mergeDraftContext({ previousDraft = null, extracted = {}, detectedService, urgency, lastUserText = '', userContext = {} }) {
  const previousPayload = previousDraft?.orderPayload || {};
  const previousExtracted = previousDraft?.extracted || payloadToExtracted(previousPayload);
  const signals = extractDraftSignals(lastUserText, previousDraft);

  const mergedExtracted = {
    ...previousExtracted,
    ...compactObject(extracted),
    ...signals.extracted
  };

  if (!mergedExtracted.location && userContext.location) {
    mergedExtracted.location = typeof userContext.location === 'string'
      ? userContext.location
      : userContext.location.text || userContext.location.address || null;
  }

  return {
    extracted: mergedExtracted,
    detectedService: normalizeCandidate(detectedService) || previousPayload.service || null,
    urgency: signals.urgency || urgency || previousPayload.urgency || 'standard'
  };
}

function attachStoredContext(draft, mergedContext = {}) {
  if (!draft || !draft.ok) return draft;
  return {
    ...draft,
    extracted: mergedContext.extracted || {},
    storedAt: new Date().toISOString()
  };
}

function payloadToExtracted(payload = {}) {
  return {
    location: payload.location || null,
    timeWindow: payload.preferredTime || null,
    budget: payload.budget || null,
    attachments: payload.attachments || []
  };
}

function extractDraftSignals(text = '', previousDraft = null) {
  const value = String(text || '').trim();
  const lower = value.toLowerCase();
  const extracted = {};

  const budget = extractBudget(lower);
  if (budget) extracted.budget = budget;

  const timeWindow = extractTimeWindow(lower);
  if (timeWindow) extracted.timeWindow = timeWindow;

  const location = extractLocation(value, previousDraft);
  if (location) extracted.location = location;

  const urgency = /(pilne|natychmiast|teraz|jak najszybciej|awaria|zalewa|cieknie mocno|iskrzy)/i.test(value)
    ? 'urgent'
    : /(nie pilne|może poczekać|moze poczekac|bez pośpiechu|bez pospiechu)/i.test(value)
      ? 'low'
      : null;

  return { extracted, urgency };
}

function extractBudget(lower) {
  const maxMatch = lower.match(/(?:do|max|maksymalnie|budżet|budzet)\s*(\d{2,5})\s*(?:zł|zl|pln)?/i);
  if (maxMatch) {
    return { min: 0, max: Number(maxMatch[1]), currency: 'PLN' };
  }
  const rangeMatch = lower.match(/(\d{2,5})\s*[-–]\s*(\d{2,5})\s*(?:zł|zl|pln)?/i);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]), currency: 'PLN' };
  }
  return null;
}

function extractTimeWindow(lower) {
  if (/\bdziś\b|\bdzis\b|dzisiaj/.test(lower)) return withHour(lower, 'dziś');
  if (/\bjutro\b/.test(lower)) return withHour(lower, 'jutro');
  if (/pojutrze/.test(lower)) return withHour(lower, 'pojutrze');
  if (/po\s*(\d{1,2})(?::\d{2})?/.test(lower)) return withHour(lower, 'po');
  if (/rano/.test(lower)) return 'rano';
  if (/wieczorem|wieczór|wieczor/.test(lower)) return 'wieczorem';
  if (/weekend|sobot|niedziel/.test(lower)) return 'w weekend';
  if (/nie pilne|może poczekać|moze poczekac|kilka dni/.test(lower)) return 'elastycznie';
  return null;
}

function withHour(lower, base) {
  const hour = lower.match(/(?:po|około|okolo|o)\s*(\d{1,2})(?::(\d{2}))?/);
  if (!hour) return base;
  return `${base} po ${hour[1]}${hour[2] ? `:${hour[2]}` : ''}`;
}

function extractLocation(value, previousDraft) {
  const lower = value.toLowerCase();
  if (/aktualn(a|ej|ą) lokalizacj|moja lokalizacja/.test(lower)) {
    return 'Aktualna lokalizacja klienta';
  }

  const explicit = value.match(/(?:w|we|na|lokalizacja|miasto|adres)\s+([A-ZĄĆĘŁŃÓŚŹŻ][\p{L}.' -]{2,60}(?:\s+\d+[A-Za-z]?)?)/u);
  if (explicit) return explicit[1].trim();

  const missingLocation = previousDraft?.missing?.includes('lokalizacja');
  const shortPlace = value.match(/^([\p{L}.' -]{3,40})(?:\s+\d+[A-Za-z]?)?$/u);
  if (missingLocation && shortPlace && !looksLikeTimeOrBudget(lower)) {
    return capitalizePlace(shortPlace[0].trim());
  }
  return null;
}

function capitalizePlace(value) {
  return value
    .split(/\s+/)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function looksLikeTimeOrBudget(lower) {
  return /\d+\s*(zł|zl|pln)|dziś|dzis|jutro|pojutrze|rano|wiecz|pilne/.test(lower);
}

function normalizeCandidate(value) {
  if (!value || value === 'inne') return null;
  return value;
}

function compactObject(obj = {}) {
  return Object.entries(obj || {}).reduce((acc, [key, value]) => {
    if (value !== null && value !== undefined && value !== '') acc[key] = value;
    return acc;
  }, {});
}

function pruneDrafts() {
  if (drafts.size <= MAX_SESSIONS) return;
  const entries = [...drafts.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  entries.slice(0, drafts.size - MAX_SESSIONS).forEach(([key]) => drafts.delete(key));
}

module.exports = {
  getDraft,
  saveDraft,
  mergeDraftContext,
  attachStoredContext,
  extractDraftSignals
};
