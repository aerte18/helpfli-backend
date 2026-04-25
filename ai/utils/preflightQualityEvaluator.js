const { callAgentLLM } = require('./llmAdapter');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeList(value, max = 4) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeTone(value = '') {
  const tone = String(value || '').toLowerCase().trim();
  return ['emerald', 'blue', 'amber', 'rose'].includes(tone) ? tone : '';
}

function normalizeLevel(value = '') {
  const level = String(value || '').toLowerCase().trim();
  if (['pro', 'good', 'basic'].includes(level)) return level;
  return 'basic';
}

function fallbackOfferQuality(payload = {}) {
  const amount = Number(payload.amount || 0);
  const message = String(payload.message || '').trim();
  const completionDate = payload.completionDate ? new Date(payload.completionDate) : null;
  const hasDate = completionDate && !Number.isNaN(completionDate.getTime()) && completionDate > new Date();
  const includes = Array.isArray(payload.priceIncludes) ? payload.priceIncludes : [];
  const hasContact = Boolean(payload.contactMethod);

  let percent = 30;
  const strengths = [];
  const warnings = [];
  const missing = [];

  if (amount > 0) {
    percent += 22;
    strengths.push('Cena jest podana.');
  } else {
    missing.push('Podaj cenę.');
  }

  if (hasDate) {
    percent += 18;
    strengths.push('Termin realizacji jest określony.');
  } else {
    missing.push('Dodaj termin realizacji.');
  }

  if (message.length >= 80) {
    percent += 20;
    strengths.push('Opis oferty jest konkretny.');
  } else if (message.length >= 25) {
    percent += 10;
    warnings.push('Opis jest krótki - doprecyzuj zakres prac.');
  } else {
    missing.push('Dodaj opis oferty.');
  }

  if (includes.length > 0) {
    percent += 6;
    strengths.push('Zakres ceny jest doprecyzowany.');
  } else {
    warnings.push('Dopisz, co obejmuje cena (robocizna, materiały, dojazd).');
  }

  if (hasContact) {
    percent += 4;
  } else {
    warnings.push('Wybierz preferowany sposób kontaktu.');
  }

  const finalPercent = clamp(Math.round(percent), 20, 100);
  return normalizeOfferQuality({
    percent: finalPercent,
    label: finalPercent >= 85 ? 'Bardzo mocna oferta' : finalPercent >= 70 ? 'Dobra oferta' : finalPercent >= 55 ? 'Do dopracowania' : 'Słaba oferta',
    tone: finalPercent >= 85 ? 'emerald' : finalPercent >= 70 ? 'blue' : finalPercent >= 55 ? 'amber' : 'rose',
    strengths,
    warnings,
    missing
  });
}

function normalizeOfferQuality(input = {}) {
  const percent = clamp(Math.round(Number(input.percent) || 0), 0, 100);
  if (!percent) return null;
  return {
    percent,
    label: String(input.label || '').slice(0, 80) || 'AI Quality',
    tone: normalizeTone(input.tone),
    missing: normalizeList(input.missing, 4),
    warnings: normalizeList(input.warnings, 4),
    strengths: normalizeList(input.strengths, 4),
    measuredAt: new Date()
  };
}

function normalizeDraftQuality(input = {}) {
  const percent = clamp(Math.round(Number(input.percent) || 0), 0, 100);
  if (!percent) return null;
  return {
    percent,
    level: normalizeLevel(input.level || (percent >= 80 ? 'pro' : percent >= 60 ? 'good' : 'basic')),
    missingForPro: normalizeList(input.missingForPro, 8),
    blockerMissing: normalizeList(input.blockerMissing, 8),
    strengths: normalizeList(input.strengths, 4),
    warnings: normalizeList(input.warnings, 4),
    measuredAt: new Date().toISOString()
  };
}

async function evaluateOfferPreflight({ orderContext = {}, offerDraft = {} }) {
  const payload = {
    service: orderContext.service || '',
    description: orderContext.description || '',
    urgency: orderContext.urgency || '',
    location: orderContext.location || '',
    budget: orderContext.budget || null,
    amount: offerDraft.amount || 0,
    message: offerDraft.message || '',
    completionDate: offerDraft.completionDate || null,
    priceIncludes: offerDraft.priceIncludes || [],
    isFinalPrice: Boolean(offerDraft.isFinalPrice),
    contactMethod: offerDraft.contactMethod || '',
    providerLevel: offerDraft.providerLevel || ''
  };

  const systemPrompt = `Jestes AI Quality Reviewer dla oferty wykonawcy.
Oceniasz szanse akceptacji i jakosc oferty PRZED wyslaniem.
Zwroc TYLKO JSON:
{
  "percent": number 0-100,
  "label": "Bardzo mocna oferta|Dobra oferta|Do dopracowania|Slaba oferta",
  "tone": "emerald|blue|amber|rose",
  "missing": string[],
  "warnings": string[],
  "strengths": string[]
}
Zasady:
- oceniaj konkretnosc, jasnosc ceny, termin, ryzyko nieporozumien, profesjonalny ton
- missing = brakujace krytyczne elementy
- warnings = ryzyka do poprawy
- strengths = mocne strony oferty
- max 4 elementy w kazdej liscie`;

  try {
    const result = await callAgentLLM({
      systemPrompt,
      agentType: 'offer_quality',
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    });
    const normalized = normalizeOfferQuality(result);
    return normalized || fallbackOfferQuality(payload);
  } catch (error) {
    console.warn('Offer preflight AI failed, using fallback:', error.message);
    return fallbackOfferQuality(payload);
  }
}

async function evaluateOrderDraftPreflight({ orderPayload = {}, extracted = {}, missing = [] }) {
  const payload = {
    service: orderPayload.service || '',
    description: orderPayload.description || '',
    location: orderPayload.location || '',
    preferredTime: orderPayload.preferredTime || '',
    budget: orderPayload.budget || '',
    urgency: orderPayload.urgency || '',
    attachments: (orderPayload.attachments || extracted.attachments || []).length,
    missing
  };

  const systemPrompt = `Jestes AI Quality Reviewer dla draftu zlecenia klienta przed utworzeniem.
Zwroc TYLKO JSON:
{
  "percent": number 0-100,
  "level": "basic|good|pro",
  "missingForPro": string[],
  "blockerMissing": string[],
  "strengths": string[],
  "warnings": string[]
}
Zasady:
- blockerMissing to elementy blokujace dobre przekazanie zlecenia wykonawcy
- missingForPro to elementy, ktore podnosza jakosc i szanse dobrej oferty
- max 8 elementow w missingForPro/blockerMissing
- max 4 elementy strengths/warnings`;

  try {
    const result = await callAgentLLM({
      systemPrompt,
      agentType: 'order_draft_quality',
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    });
    const normalized = normalizeDraftQuality(result);
    if (normalized) return normalized;
  } catch (error) {
    console.warn('Order draft preflight AI failed, using fallback:', error.message);
  }

  const checks = [
    { ok: !!orderPayload.service && orderPayload.service !== 'inne', label: 'wybrana usługa' },
    { ok: !!orderPayload.description && orderPayload.description.length >= 25, label: 'konkretny opis' },
    { ok: !!orderPayload.location, label: 'lokalizacja' },
    { ok: !!orderPayload.preferredTime, label: 'termin' },
    { ok: (orderPayload.attachments || extracted.attachments || []).length > 0, label: 'zdjęcia' }
  ];
  const passed = checks.filter((item) => item.ok);
  const percent = Math.round((passed.length / checks.length) * 100);
  return normalizeDraftQuality({
    percent,
    level: percent >= 80 ? 'pro' : percent >= 60 ? 'good' : 'basic',
    missingForPro: checks.filter((item) => !item.ok).map((item) => item.label),
    blockerMissing: missing,
    strengths: passed.map((item) => `Uzupełniono: ${item.label}`).slice(0, 4),
    warnings: checks.filter((item) => !item.ok).map((item) => `Brakuje: ${item.label}`).slice(0, 4)
  });
}

module.exports = {
  evaluateOfferPreflight,
  evaluateOrderDraftPreflight,
  evaluateProviderMessagePreflight,
  normalizeOfferQuality
};

async function evaluateProviderMessagePreflight({ orderContext = {}, draft = {} }) {
  const payload = {
    assistantMode: draft.assistantMode || 'offer',
    message: String(draft.message || ''),
    service: orderContext.service || '',
    urgency: orderContext.urgency || '',
    location: orderContext.location || '',
    hasAttachments: Number(orderContext.attachments || 0) > 0,
    budget: orderContext.budget || null
  };

  const systemPrompt = `Jestes AI quality reviewer dla wiadomosci wykonawcy do klienta.
Oceniasz jakosc tekstu PRZED wyslaniem.
Zwroc TYLKO JSON:
{
  "percent": number 0-100,
  "label": "Bardzo mocna wiadomosc|Dobra wiadomosc|Do dopracowania|Slaba wiadomosc",
  "tone": "emerald|blue|amber|rose",
  "missing": string[],
  "warnings": string[],
  "strengths": string[]
}
Zasady:
- oceniaj konkretnosc, profesjonalizm, uprzejmosc, jasne kolejne kroki
- missing = brakujace krytyczne elementy
- warnings = ryzyka i niejasnosci
- strengths = mocne strony
- max 4 elementy na liste`;

  try {
    const result = await callAgentLLM({
      systemPrompt,
      agentType: 'provider_message_quality',
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    });
    const normalized = normalizeOfferQuality(result);
    if (normalized) return normalized;
  } catch (error) {
    console.warn('Provider message preflight AI failed, using fallback:', error.message);
  }

  const text = String(payload.message || '').trim();
  let percent = 30;
  const strengths = [];
  const warnings = [];
  const missing = [];

  if (text.length >= 35) {
    percent += 18;
    strengths.push('Wiadomość ma sensowną długość.');
  } else if (text.length >= 15) {
    percent += 8;
    warnings.push('Wiadomość jest krótka - doprecyzuj zakres lub następny krok.');
  } else {
    missing.push('Dodaj pełniejsze wyjaśnienie dla klienta.');
  }

  if (/(dzień dobry|dzien dobry|cześć|czesc|witam)/i.test(text)) {
    percent += 10;
    strengths.push('Ton jest uprzejmy.');
  } else {
    warnings.push('Dodaj uprzejmy początek wiadomości.');
  }

  if (/(termin|godzin|kiedy|jutro|dzis)/i.test(text)) {
    percent += 12;
    strengths.push('Wiadomość zawiera element terminu.');
  } else {
    warnings.push('Warto podać proponowany termin lub okno czasowe.');
  }

  if (/(cena|zł|pln|koszt)/i.test(text)) {
    percent += 10;
    strengths.push('Wiadomość odnosi się do ceny.');
  }

  if (/(proszę|czy mogę|czy pasuje|potwierd|daj znać|odpowied)/i.test(text)) {
    percent += 10;
    strengths.push('Jest jasne wezwanie do odpowiedzi.');
  } else {
    missing.push('Dodaj jedno konkretne pytanie lub CTA do klienta.');
  }

  const finalPercent = clamp(Math.round(percent), 20, 100);
  return normalizeOfferQuality({
    percent: finalPercent,
    label: finalPercent >= 85 ? 'Bardzo mocna wiadomość' : finalPercent >= 70 ? 'Dobra wiadomość' : finalPercent >= 55 ? 'Do dopracowania' : 'Słaba wiadomość',
    tone: finalPercent >= 85 ? 'emerald' : finalPercent >= 70 ? 'blue' : finalPercent >= 55 ? 'amber' : 'rose',
    strengths,
    warnings,
    missing
  });
}

