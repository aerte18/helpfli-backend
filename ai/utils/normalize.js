/**
 * Narzędzia do normalizacji danych dla AI Agentów
 */

function normalizeServiceName(service) {
  if (!service || typeof service !== 'string') return 'inne';
  const s = service.trim().toLowerCase();
  if (!s) return 'inne';
  
  // Mapowanie typowych wariantów
  const mappings = {
    'hydraulik': 'hydraulik_naprawa',
    'hydraulika': 'hydraulik_naprawa',
    'elektryk': 'elektryk_naprawa',
    'elektryka': 'elektryk_naprawa',
    'złota rączka': 'zlota_raczka',
    'golden hand': 'zlota_raczka',
    'sprzątanie': 'sprzatanie',
    'cleaning': 'sprzatanie',
    'remont': 'remont',
    'renovation': 'remont',
    'agd': 'agd-rtv-naprawa-agd',
    'rtv': 'agd-rtv-naprawa-rtv',
    'agd rtv': 'agd-rtv-naprawa-agd',
    'agd/rtv': 'agd-rtv-naprawa-agd',
    'agd-rtv': 'agd-rtv-naprawa-agd',
    'agd_rtv': 'agd-rtv-naprawa-agd',
    'naprawa agd': 'agd-rtv-naprawa-agd',
    'serwis agd': 'agd-rtv-naprawa-agd',
    'pralka': 'agd-rtv-naprawa-agd',
    'zmywarka': 'agd-rtv-naprawa-agd',
    'lodówka': 'agd-rtv-naprawa-agd',
    'lodowka': 'agd-rtv-naprawa-agd',
    'piekarnik': 'agd-rtv-naprawa-agd',
    'telewizor': 'agd-rtv-naprawa-rtv',
    'tv': 'agd-rtv-naprawa-rtv'
  };
  
  return mappings[s] || s;
}

function safeNumber(val, fallback = 0) {
  if (val === null || val === undefined) return fallback;
  const n = Number(val);
  return Number.isFinite(n) && !Number.isNaN(n) ? n : fallback;
}

function normalizeUrgency(urgency) {
  const u = String(urgency || '').toLowerCase().trim();
  if (['low', 'standard', 'urgent'].includes(u)) return u;
  if (['normal', 'flex', 'regular'].includes(u)) return 'standard';
  if (['now', 'immediately', 'pilne'].includes(u)) return 'urgent';
  return 'standard';
}

function normalizeLocation(location) {
  if (!location || typeof location !== 'object') return null;
  
  return {
    text: String(location.text || location.address || ''),
    lat: safeNumber(location.lat, null),
    lng: safeNumber(location.lng, null),
    radiusKm: safeNumber(location.radiusKm, 10)
  };
}

function normalizeBudget(budget) {
  if (!budget || typeof budget !== 'object') return null;
  
  const min = safeNumber(budget.min, null);
  const max = safeNumber(budget.max, null);
  
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) return null;
  
  return {
    min: min !== null ? min : 0,
    max: max !== null ? max : Infinity,
    currency: String(budget.currency || 'PLN').toUpperCase()
  };
}

function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  const keywords = [];
  const lower = text.toLowerCase();
  
  // Zagrożenia
  if (/(gaz|wyciek|zapach gazu|ulatuj)/.test(lower)) keywords.push('gas');
  if (/(prąd|iskr|zwarc|bezpiecznik|porażenie|elektryk)/.test(lower)) keywords.push('electricity');
  if (/(woda|zalanie|wyciek|ciekn)/.test(lower)) keywords.push('water');
  if (/(ogień|płonie|dym|spali)/.test(lower)) keywords.push('fire');
  if (/(pralk|zmywark|lod[oó]wk|piekarnik|kuchenk|agd|rtv|telewizor|\btv\b)/.test(lower)) keywords.push('appliance');
  
  // Pilność
  if (/(pilne|teraz|natychmiast|awaria|krytyczne)/.test(lower)) keywords.push('urgent');
  if (/(jutro|pojutrze|w tym tygodniu)/.test(lower)) keywords.push('soon');
  if (/(może poczekać|nie pilne|kiedykolwiek)/.test(lower)) keywords.push('flexible');
  
  return keywords;
}

module.exports = {
  normalizeServiceName,
  safeNumber,
  normalizeUrgency,
  normalizeLocation,
  normalizeBudget,
  extractKeywords
};

