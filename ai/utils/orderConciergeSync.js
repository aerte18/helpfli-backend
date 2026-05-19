/**
 * Synchronizacja odpowiedzi Concierge z draftem zlecenia — fazowy, „ludzki” flow
 */

const WANTS_ORDER_PATTERN =
  /wystaw|utwórz|utworz|stwórz|stworz|załóż|zaloz|chc[eę]\s+(utworzyć|utworzyc)\s+zlecen|chc[eę]\s+zlecen|potwierdzam.*zlecen|utworzyć zlecenie|utworzyc zlecenie/i;
const WANTS_PROVIDERS_PATTERN =
  /(?:znajd[zź]|poszukaj|wyszukaj|pokaż|pokaz|szukaj).{0,40}(?:wykonawc|fachowc|hydraulik|specjalist)|znajd[zź]\s+prosz[eę]?|pokaż (mi )?(wykonawc|list)|pokaz (mi )?(wykonawc|list)|masz (już )?wynik|i jak masz|są wyniki|kto może przyjechać/i;
const PROVIDERS_FOLLOWUP_PATTERN =
  /i jak masz|masz wyniki|są wyniki|co znalaz|znalazłeś|znalazles|pokaż (mi )?(ich|list)|gdzie (są|sa) (ci )?wykonawc|w okolicy|w\s+okolic|jakikolwiek|jakichkolwiek|ktokolwiek|s[aą]\s+jacy|s[aą]\s+jacyś|jest ktoś|jest ktos|ktoś w pobliżu|ktos w poblizu|poszerz|szerszy obszar|dalej szukaj/i;
const WANTS_PRICING_PATTERN = /cen|koszt|widełki|widełek|wycen|ile (to )?koszt|orientacyjn(e|ych) widełki/i;
const WANTS_DIY_PATTERN = /sam(odzielnie)?|diy|krok po kroku|zr[oó]b(ię|ie)?\s+sam|bezpieczne kroki/i;
const DIY_FAILED_PATTERN =
  /nie pomog|nie działa dalej|dalej nie działa|nadal nie działa|bez zmian|nie zadziałało|nie zadzialalo/i;

const CHOSEN_PATH_MAP = {
  order: 'order',
  create_order: 'order',
  providers: 'providers',
  suggest_providers: 'providers',
  pricing: 'pricing',
  show_pricing: 'pricing',
  diy: 'diy',
  suggest_diy: 'diy'
};

function wantsToCreateOrder(text = '') {
  return WANTS_ORDER_PATTERN.test(String(text));
}

function wantsProviders(text = '') {
  return WANTS_PROVIDERS_PATTERN.test(String(text));
}

function wantsPricing(text = '') {
  return WANTS_PRICING_PATTERN.test(String(text));
}

function wantsDiy(text = '') {
  return WANTS_DIY_PATTERN.test(String(text));
}

function detectChosenPathFromText(text = '', existingPath = null) {
  const t = String(text || '');
  if (DIY_FAILED_PATTERN.test(t)) return 'order';
  if (wantsToCreateOrder(t)) return 'order';
  if (wantsProviders(t) || PROVIDERS_FOLLOWUP_PATTERN.test(t)) return 'providers';
  if (wantsPricing(t)) return 'pricing';
  if (wantsDiy(t)) return 'diy';
  return existingPath || null;
}

function isCoreOrderMissing(label = '') {
  return /kategoria usługi|opis problemu|lokalizacja/i.test(String(label));
}

function filterCoreMissing(missing = []) {
  return (missing || []).filter(isCoreOrderMissing);
}

function stripOrderReadyFooter(text = '') {
  return String(text || '')
    .replace(/\n*\*\*Mam komplet danych\*\*[^\n]*/gi, '')
    .replace(/\n*Gdy dasz mi te informacje[^\n]*/gi, '')
    .replace(/\n*Mam już podstawowe informacje[^\n]*/gi, '')
    .replace(/\n*\*\*Co wolisz teraz\?\*\*[^\n]*/gi, '')
    .trim();
}

function cleanDescriptionText(text = '') {
  return String(text || '')
    .replace(/\[Moja lokalizacja:[^\]]*\]/gi, '')
    .replace(/\[STATUS ZAŁĄCZONEGO ZDJĘCIA\][\s\S]*?(?=\n\n|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatLocationDisplay(location, fallbackLocationText = null) {
  const raw = location || fallbackLocationText || '';
  const text = typeof raw === 'object' ? raw.text || raw.address : raw;
  if (!text || typeof text !== 'string') return null;
  if (/aktualna lokalizacja klienta/i.test(text)) {
    return fallbackLocationText && !/aktualna lokalizacja/i.test(String(fallbackLocationText))
      ? String(fallbackLocationText)
      : 'Twoja lokalizacja (GPS)';
  }
  return text.trim();
}

function computeUiPhase({
  concierge = {},
  draft = {},
  lastUserText = '',
  userMessageCount = 0,
  chosenPath = null
}) {
  const missing = draft?.missing || [];
  const path = chosenPath || detectChosenPathFromText(lastUserText);

  if (concierge.diagnosticFlow) return 'diagnose';

  if (path === 'order') {
    return missing.length > 0 ? 'clarify' : 'create_order';
  }
  if (path === 'providers') {
    const coreMissing = filterCoreMissing(missing);
    return coreMissing.length > 0 ? 'clarify' : 'providers';
  }
  if (path === 'pricing') {
    return missing.length > 0 ? 'clarify' : 'pricing';
  }
  if (path === 'diy') {
    return 'diy';
  }

  if (missing.length > 0 || concierge.nextStep === 'ask_more') {
    return 'clarify';
  }

  if (concierge.nextStep === 'offer_choices' || (draft?.canCreate && userMessageCount >= 2)) {
    return 'choose_action';
  }

  if (concierge.nextStep === 'create_order') return 'create_order';
  if (concierge.nextStep === 'suggest_providers') return 'providers';
  if (concierge.nextStep === 'show_pricing') return 'pricing';
  if (concierge.nextStep === 'suggest_diy') return 'diy';

  return 'clarify';
}

function computeConversationStep(uiPhase = 'clarify') {
  const map = {
    clarify: { step: 1, total: 3, label: 'Doprecyzowanie problemu' },
    diagnose: { step: 1, total: 3, label: 'Ocena sytuacji' },
    choose_action: { step: 2, total: 3, label: 'Wybór: wykonawca, zlecenie lub cena' },
    create_order: { step: 3, total: 3, label: 'Przygotowanie zlecenia' },
    providers: { step: 3, total: 3, label: 'Wyszukiwanie wykonawców' },
    pricing: { step: 3, total: 3, label: 'Orientacyjna wycena' },
    diy: { step: 3, total: 3, label: 'Kroki DIY' }
  };
  return map[uiPhase] || map.clarify;
}

function buildConversationSummary(draft = {}, { detectedService, fallbackLocation = null } = {}) {
  const parts = [];
  const service = draft.summary?.service || draft.orderPayload?.service || detectedService;
  const desc = cleanDescriptionText(
    draft.summary?.description || draft.orderPayload?.description || ''
  ).slice(0, 120);
  const loc = formatLocationDisplay(
    draft.summary?.location || draft.orderPayload?.location,
    fallbackLocation
  );
  const time = draft.summary?.preferredTime || draft.orderPayload?.preferredTime;

  if (service && service !== 'inne') {
    parts.push(typeof service === 'string' ? service.replace(/_/g, ' ') : String(service));
  }
  if (desc) parts.push(desc);
  if (loc) parts.push(loc);
  if (time) parts.push(`termin: ${time}`);

  if (parts.length === 0) return 'Podsumowuję to, co już wiem z rozmowy.';
  return `Rozumiem: ${parts.join(' · ')}.`;
}

function enrichConciergeWithOrderDraft(
  concierge = {},
  draft = {},
  { lastUserText = '', userMessageCount = 0, chosenPath = null, fallbackLocation = null } = {}
) {
  if (!draft || !draft.ok) return concierge;

  concierge.reply = stripOrderReadyFooter(concierge.reply);
  const missing = draft.missing || [];
  const path = chosenPath || detectChosenPathFromText(lastUserText);

  const effectiveMissing = path === 'providers' ? filterCoreMissing(missing) : missing;

  if (effectiveMissing.length > 0) {
    concierge.nextStep = 'ask_more';
    concierge.missing = effectiveMissing;
    concierge.questions = draft.nextQuestion ? [draft.nextQuestion] : (draft.questions || []).slice(0, 1);
    if (!concierge.reply?.includes('?') && draft.nextQuestion) {
      concierge.reply = `${concierge.reply}\n\n${draft.nextQuestion}`.trim();
    }
    if (path === 'order') {
      const gap = draft.gapAnalysis;
      const filled = gap?.filled?.map((f) => f.label).join(', ');
      const need = missing.join(', ');
      if (filled && !/mam już|zebrane/i.test(concierge.reply || '')) {
        concierge.reply = `${concierge.reply}\n\n**Mam już:** ${filled}.`.trim();
      }
      if (need && !concierge.reply.toLowerCase().includes(need.slice(0, 8).toLowerCase())) {
        concierge.reply = `${concierge.reply}\n\n**Do zlecenia potrzebuję jeszcze:** ${need}.`.trim();
      }
    }
    return concierge;
  }

  if (path === 'order') {
    concierge.nextStep = 'create_order';
    concierge.questions = [];
    return concierge;
  }
  if (path === 'providers') {
    concierge.nextStep = 'suggest_providers';
    concierge.questions = [];
    return concierge;
  }
  if (path === 'pricing') {
    concierge.nextStep = 'show_pricing';
    concierge.questions = [];
    return concierge;
  }
  if (path === 'diy') {
    concierge.nextStep = 'suggest_diy';
    concierge.questions = [];
    return concierge;
  }

  if (draft.canCreate && userMessageCount >= 2) {
    concierge.nextStep = 'offer_choices';
    concierge.questions = [];
    const summary = buildConversationSummary(draft, {
      detectedService: concierge.detectedService,
      fallbackLocation
    });
    concierge.conversationSummary = summary;
    if (!/rozumiem|co wolisz|co chcesz/i.test(concierge.reply || '')) {
      concierge.reply = `${concierge.reply}\n\n${summary} **Co wolisz zrobić?** Wybierz jedną opcję poniżej.`.trim();
    }
    return concierge;
  }

  if (draft.canCreate) {
    concierge.nextStep = 'ask_more';
    concierge.questions = draft.nextQuestion ? [draft.nextQuestion] : [];
  } else if (draft.nextQuestion) {
    concierge.questions = [draft.nextQuestion];
  }

  return concierge;
}

function normalizeAttachmentsFromUrls(urls = []) {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  return urls
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => {
      const trimmed = url.trim();
      const filename = trimmed.split('/').pop()?.split('?')[0] || 'zdjecie.jpg';
      const lower = filename.toLowerCase();
      let mimeType = 'application/octet-stream';
      if (/\.(jpe?g)$/i.test(lower)) mimeType = 'image/jpeg';
      else if (/\.png$/i.test(lower)) mimeType = 'image/png';
      else if (/\.webp$/i.test(lower)) mimeType = 'image/webp';
      else if (/\.gif$/i.test(lower)) mimeType = 'image/gif';
      else if (/\.(heic|heif)$/i.test(lower)) mimeType = 'image/heic';
      return { url: trimmed, mimeType, filename, size: 0 };
    })
    .filter((att) => {
      if (seen.has(att.url)) return false;
      seen.add(att.url);
      return true;
    });
}

function mergeAttachmentLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      const url = typeof item === 'string' ? item : item?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(typeof item === 'string' ? normalizeAttachmentsFromUrls([item])[0] : item);
    }
  }
  return out;
}

function isProviderSearchFollowUp(text = '') {
  return PROVIDERS_FOLLOWUP_PATTERN.test(String(text || ''));
}

function canRunProviderMatching({
  chosenPath = null,
  userMessageCount = 0,
  lastUserText = '',
  concierge = {},
  draft = null,
  blockHeavyAgents = false,
  explicitPathFromClient = false
}) {
  if (blockHeavyAgents) return false;
  const followUp = isProviderSearchFollowUp(lastUserText);
  if (userMessageCount < 2 && !explicitPathFromClient && !followUp) return false;
  const wantsProviders =
    chosenPath === 'providers' ||
    concierge.nextStep === 'suggest_providers' ||
    concierge.uiPhase === 'providers' ||
    followUp;
  if (!wantsProviders) return false;
  if (filterCoreMissing(draft?.missing || []).length > 0) return false;
  return true;
}

function enrichConciergeWithMatching(concierge = {}, matching = null) {
  if (!matching) return concierge;

  const inClarify =
    concierge.nextStep === 'ask_more' ||
    concierge.uiPhase === 'clarify' ||
    (concierge.questions && concierge.questions.length > 0);

  const providers = matching.topProviders || [];
  if (providers.length === 0) {
    if (inClarify) return concierge;
    const loc = matching.location?.text || 'tej okolicy';
    const note =
      matching.searchExpanded
        ? `Poszerzyłem wyszukiwanie — nadal nie mam aktywnych profili w ${loc}. Możesz **wystawić zlecenie** (wykonawcy sami odpowiedzą) albo przejść do **mapy wykonawców** na stronie głównej.`
        : `Na razie nie widzę dopasowanych wykonawców w ${loc}. Spróbuję poszerzyć zakres — albo **wystaw zlecenie**, wtedy fachowcy sami się odezwą.`;
    concierge.matchingEmpty = true;
    concierge.questions = [];
    if (/szukam|zaraz|wyciągnę|wyciagne|najlepszych/i.test(concierge.reply || '')) {
      concierge.reply = note;
    } else if (!concierge.reply?.includes('wykonawc')) {
      concierge.reply = `${concierge.reply}\n\n${note}`.trim();
    } else if (!concierge.reply?.includes('zlecenie')) {
      concierge.reply = `${concierge.reply}\n\n${note}`.trim();
    }
    return concierge;
  }

  const count = providers.length;
  const names = providers
    .slice(0, 3)
    .map((p) => p.name)
    .join(', ');
  const summary = `Znalazłem ${count} ${count === 1 ? 'wykonawcę' : 'wykonawców'} w okolicy${names ? `: ${names}` : ''}. Wybierz profil poniżej.`;

  if (/szukam|zaraz będą wyniki|będą wyniki|zaraz będą/i.test(concierge.reply || '')) {
    concierge.reply = summary;
  } else if (!/znalazłem|znaleźliśmy|oto wykonawc/i.test(concierge.reply || '')) {
    concierge.reply = `${concierge.reply}\n\n${summary}`.trim();
  }

  concierge.nextStep = 'suggest_providers';
  return concierge;
}

function applyDisplayFieldsToDraft(draft, fallbackLocation = null) {
  if (!draft?.orderPayload) return draft;
  const payload = draft.orderPayload;
  payload.description = cleanDescriptionText(payload.description);
  const displayLocation = formatLocationDisplay(payload.location, fallbackLocation);
  draft.summary = {
    ...(draft.summary || {}),
    description: payload.description,
    location: displayLocation || draft.summary?.location || 'Do ustalenia',
    service: draft.summary?.service || payload.service,
    preferredTime: draft.summary?.preferredTime || payload.preferredTime || 'Do ustalenia'
  };
  if (displayLocation) {
    payload.location = displayLocation;
  }
  return draft;
}

module.exports = {
  wantsToCreateOrder,
  wantsProviders,
  wantsPricing,
  wantsDiy,
  detectChosenPathFromText,
  isProviderSearchFollowUp,
  isCoreOrderMissing,
  filterCoreMissing,
  PROVIDERS_FOLLOWUP_PATTERN,
  enrichConciergeWithOrderDraft,
  computeUiPhase,
  computeConversationStep,
  buildConversationSummary,
  normalizeAttachmentsFromUrls,
  mergeAttachmentLists,
  stripOrderReadyFooter,
  cleanDescriptionText,
  formatLocationDisplay,
  applyDisplayFieldsToDraft,
  enrichConciergeWithMatching,
  canRunProviderMatching,
  CHOSEN_PATH_MAP
};
