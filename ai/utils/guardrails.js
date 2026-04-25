/**
 * Guardrails dla bezpieczeństwa AI Agentów
 * Zapewnia że odpowiedzi są bezpieczne, spójne i zgodne z oczekiwaniami
 */

const { normalizeUrgency, safeNumber, normalizeServiceName } = require('./normalize');
const { applySafetyTriage } = require('./safetyTriage');

function guardrailEnforce(ai) {
  if (!ai || typeof ai !== 'object') {
    throw new Error('AI response must be an object');
  }

  const out = { ...ai };

  // Guardrails dla podstawowych pól
  if (!out.urgency) out.urgency = 'standard';
  out.urgency = normalizeUrgency(out.urgency);
  
  if (typeof out.confidence !== 'number') out.confidence = 0.5;
  out.confidence = Math.max(0, Math.min(1, out.confidence));
  
  if (!out.nextStep) out.nextStep = 'ask_more';
  
  if (!Array.isArray(out.questions)) out.questions = [];
  out.questions = out.questions.slice(0, 5); // Max 5 pytań
  
  // Przycinanie odpowiedzi do max 2000 znaków
  out.reply = String(out.reply || '').slice(0, 2000);
  
  // Normalizacja usługi
  if (out.detectedService) {
    out.detectedService = normalizeServiceName(out.detectedService);
  } else {
    out.detectedService = 'inne';
  }

  // Walidacja i normalizacja budżetu
  if (out.budget && typeof out.budget === 'object') {
    const min = safeNumber(out.budget.min, null);
    const max = safeNumber(out.budget.max, null);
    
    if (min !== null && max !== null && min > max) {
      out.budget = null;
    } else if (min !== null || max !== null) {
      out.budget = {
        min: min !== null ? min : 0,
        max: max !== null ? max : Infinity,
        currency: String(out.budget.currency || 'PLN').toUpperCase()
      };
    } else {
      out.budget = null;
    }
  } else {
    out.budget = null;
  }

  // Bezpieczeństwo - sprawdzenie flag bezpieczeństwa
  if (!out.safety || typeof out.safety !== 'object') {
    out.safety = { flag: false, reason: null, recommendation: null };
  }

  // Jeśli wykryto wysokie ryzyko, wymuś odpowiednią pilność
  if (out.safety.flag === true && out.urgency !== 'urgent') {
    out.urgency = 'urgent';
    if (!out.safety.recommendation) {
      out.safety.recommendation = 'Zalecamy natychmiastowy kontakt z fachowcem';
    }
  }

  // Normalizacja extracted data
  if (!out.extracted || typeof out.extracted !== 'object') {
    out.extracted = {
      location: null,
      timeWindow: null,
      budget: null,
      details: []
    };
  } else {
    if (!Array.isArray(out.extracted.details)) {
      out.extracted.details = [];
    }
  }

  // Normalizacja missing data
  if (!Array.isArray(out.missing)) {
    out.missing = [];
  }

  return out;
}

function enforceSafetyRules(response, userMessage = '') {
  const messageLower = String(userMessage).toLowerCase();
  
  // Wykrywanie niebezpiecznych sytuacji
  const dangerousKeywords = {
    gas: /(gaz|wyciek gazu|zapach gazu|ulatuj)/i,
    electricity: /(iskr|zwarc|porażenie|dym z gniazdka)/i,
    fire: /(ogień|płonie|spali)/i,
    water: /(zalanie|woda zalewa)/i
  };

  const detectedDangers = [];
  for (const [key, regex] of Object.entries(dangerousKeywords)) {
    if (regex.test(messageLower)) {
      detectedDangers.push(key);
    }
  }

  // Jeśli wykryto niebezpieczeństwo, wymuś odpowiednie zachowanie
  if (detectedDangers.length > 0 && !response.safety?.flag) {
    response.safety = {
      flag: true,
      reason: `Wykryto potencjalne zagrożenie: ${detectedDangers.join(', ')}`,
      recommendation: 'Zalecamy natychmiastowy kontakt z odpowiednimi służbami lub fachowcem'
    };
    response.urgency = 'urgent';
    response.nextStep = 'suggest_providers'; // Nie proponuj DIY w niebezpiecznych sytuacjach
  }

  return applySafetyTriage(response, userMessage);
}

function sanitizeOutput(output) {
  if (typeof output !== 'object' || output === null) return output;
  
  const sanitized = {};
  for (const [key, value] of Object.entries(output)) {
    if (value === null || value === undefined) continue;
    
    // Usuń potencjalnie niebezpieczne dane
    if (typeof value === 'string') {
      // Usuń potencjalne skrypty XSS (prosta wersja)
      sanitized[key] = value
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .slice(0, 10000); // Max długość
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item => sanitizeOutput(item));
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeOutput(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

module.exports = {
  guardrailEnforce,
  enforceSafetyRules,
  sanitizeOutput
};

