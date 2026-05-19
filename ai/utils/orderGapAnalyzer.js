/**
 * Analiza luk w danych zlecenia — co mamy z rozmowy vs co potrzebuje wykonawca.
 * Reguły per kategoria usługi + tryb strict przy intencji „wystaw zlecenie”.
 */

const { wantsToCreateOrder } = require('./orderConciergeSync');

const BRAND_PATTERN =
  /\b(samsung|beko|lg|bosch|whirlpool|amica|electrolux|siemens|miele|aeg|indesit|candy|hoover|zanussi|gorenje|sharp|panasonic|philips|dyson)\b/i;
const MODEL_PATTERN = /\b(model|mod\.?)\s*[:#]?\s*([\w.-]{2,20})\b/i;
const ERROR_CODE_PATTERN = /\b([efk]\d{2,4}|h\d{2})\b|kod\s*(błędu|bledu)/i;

function getConversationText(messages = []) {
  return messages
    .filter((m) => m && m.role === 'user')
    .map((m) => m.content || m.text || '')
    .join('\n');
}

function detectServiceFamily(service = '', description = '') {
  const s = `${service} ${description}`.toLowerCase();
  if (/agd|rtv|pralk|zmywark|lod[oó]wk|piekarnik|kuchenk|suszark|zmywark/i.test(s)) return 'agd';
  if (/hydraul|kran|wyciek|rur|kanaliz|wc\b|udrażn|udrazn|boiler|bojler/i.test(s)) return 'hydraulics';
  if (/elektr|gniazd|bezpiecznik|prąd|prad|oświetl|oswietl|instalacj elektr/i.test(s)) return 'electrical';
  if (/malow|tapet|ścian|scian|remont|gladz|gładź|tynk/i.test(s)) return 'renovation';
  if (/sprząt|sprzat|mycie okien|porządk/i.test(s)) return 'cleaning';
  if (/montaż|montaz|mebli|drzwi|okien|klimatyz/i.test(s)) return 'installation';
  return 'general';
}

function buildContext(messages, extracted = {}, orderPayload = {}) {
  const text = getConversationText(messages);
  const desc = `${orderPayload.description || ''} ${text}`;
  const lower = desc.toLowerCase();
  const details = Array.isArray(extracted.details) ? extracted.details : [];

  const deviceMatch = lower.match(/\b(pralka|zmywarka|lod[oó]wka|piekarnik|kuchenka|zmywarka|suszarka|odkurzacz|telewizor|tv)\b/);
  const brandMatch = lower.match(BRAND_PATTERN);
  const modelMatch = desc.match(MODEL_PATTERN);
  const errorMatch = lower.match(ERROR_CODE_PATTERN);

  const hasBrand = Boolean(brandMatch || details.some((d) => BRAND_PATTERN.test(d)));
  const hasModel = Boolean(modelMatch || /\b\w{2,}-\w{2,}\b/.test(desc) && hasBrand);
  const hasErrorCode = Boolean(errorMatch || /kod|błąd|bled|e\d{2}/i.test(lower));
  const hasSymptom = Boolean(
    /(nie (włącz|wlacz|działa|dziala|wiruje|grzeje|chłodzi|chlodzi)|cieknie|hałas|halas|wyświetla|wyswietla|pęka|peknie|iskrzy|zapach|wyciek)/i.test(
      lower
    )
  );
  const hasDeviceType = Boolean(deviceMatch || /agd|rtv/i.test(lower));
  const hasLocation = Boolean(
    orderPayload.location &&
      String(orderPayload.location).trim().length >= 2 &&
      !/aktualna lokalizacja klienta/i.test(String(orderPayload.location))
  );
  const hasTerm = Boolean(extracted.timeWindow || orderPayload.preferredTime);
  const hasBudget = Boolean(extracted.budget || orderPayload.budget);
  const hasPhotos = (orderPayload.attachments || extracted.attachments || []).length > 0;
  const hasAccessInfo = /(mieszkan|piętr|pietr|dom|blok|klatka|dostęp|dostep|parkow)/i.test(lower);
  const hasRoomScope = /(pokój|pokoj|m2|metr|łazienk|lazienk|kuchni|salon|całe|cale)/i.test(lower);

  return {
    text,
    lower,
    desc,
    details,
    deviceType: deviceMatch?.[1] || extracted.deviceType || null,
    brand: brandMatch?.[1] || extracted.brand || null,
    model: modelMatch?.[2] || extracted.model || null,
    hasBrand,
    hasModel,
    hasErrorCode,
    hasSymptom,
    hasDeviceType,
    hasLocation,
    hasTerm,
    hasBudget,
    hasPhotos,
    hasAccessInfo,
    hasRoomScope
  };
}

function field(id, label, question, opts = {}) {
  return {
    id,
    label,
    question,
    field: opts.field || id,
    priority: opts.priority || 'blocker',
    quickReplies: opts.quickReplies || []
  };
}

function getFieldCatalog(family) {
  const commonTerm = field('term', 'termin wizyty', 'Kiedy wykonawca ma przyjechać — dziś, jutro, czy termin jest elastyczny?', {
    field: 'timeWindow',
    priority: 'blocker',
    quickReplies: [
      { label: 'Dziś', value: 'Potrzebuję pomocy dzisiaj' },
      { label: 'Jutro', value: 'Może być jutro' },
      { label: 'Elastycznie', value: 'Termin jest elastyczny, może poczekać kilka dni' }
    ]
  });

  const catalogs = {
    agd: [
      field('device_type', 'rodzaj urządzenia', 'Jakie to urządzenie — pralka, zmywarka, lodówka czy coś innego?', {
        field: 'deviceType',
        quickReplies: [
          { label: 'Pralka', value: 'To pralka' },
          { label: 'Zmywarka', value: 'To zmywarka' },
          { label: 'Lodówka', value: 'To lodówka' }
        ]
      }),
      field('brand_model', 'marka i model', 'Jaka jest marka i model urządzenia? (np. Beko WRE6512 — z tabliczki znamionowej)', {
        field: 'brandModel',
        quickReplies: [
          { label: 'Beko', value: 'Marka: Beko' },
          { label: 'Samsung', value: 'Marka: Samsung' },
          { label: 'Nie znam modelu', value: 'Nie znam dokładnego modelu, mogę podać zdjęcie tabliczki' }
        ]
      }),
      field('symptom', 'objawy / kod błędu', 'Co dokładnie się dzieje — kod błędu na wyświetlaczu, brak wirowania, wyciek?', {
        field: 'symptom',
        quickReplies: [
          { label: 'Kod błędu', value: 'Pojawia się kod błędu na wyświetlaczu' },
          { label: 'Nie wiruje', value: 'Pralka nie wiruje' },
          { label: 'Cieknie', value: 'Urządzenie cieknie' }
        ]
      }),
      field('photo', 'zdjęcie problemu', 'Czy możesz dodać zdjęcie kodu błędu lub tabliczki znamionowej?', {
        priority: 'recommended',
        field: 'attachments',
        quickReplies: [
          { label: 'Dodam zdjęcie', value: 'Dodam zdjęcie kodu błędu lub tabliczki znamionowej' },
          { label: 'Nie mam teraz', value: 'Nie mam teraz zdjęcia, opiszę słownie' }
        ]
      }),
      commonTerm
    ],
    hydraulics: [
      field('symptom', 'opis usterki', 'Co dokładnie się dzieje — cieknie kran, zatkany odpływ, brak ciepłej wody?', {
        field: 'symptom',
        quickReplies: [
          { label: 'Cieknie', value: 'Cieknie woda' },
          { label: 'Zatkany odpływ', value: 'Zatkany odpływ / WC' },
          { label: 'Brak ciepłej wody', value: 'Brak ciepłej wody lub niskie ciśnienie' }
        ]
      }),
      field('location_detail', 'miejsce awarii', 'Gdzie dokładnie jest problem — kuchnia, łazienka, piwnica?', {
        field: 'locationDetail',
        quickReplies: [
          { label: 'Kuchnia', value: 'Problem w kuchni' },
          { label: 'Łazienka', value: 'Problem w łazience' },
          { label: 'Inne', value: 'Problem w innym miejscu w domu' }
        ]
      }),
      field('photo', 'zdjęcie miejsca', 'Zdjęcie miejsca wycieku lub uszkodzenia pomoże wykonawcy — dodasz?', {
        priority: 'recommended',
        field: 'attachments',
        quickReplies: [{ label: 'Dodam zdjęcie', value: 'Dodam zdjęcie miejsca awarii' }]
      }),
      commonTerm
    ],
    electrical: [
      field('symptom', 'objaw awarii', 'Co się dzieje — brak prądu w pokoju, iskrzy gniazdko, nie działa oświetlenie?', {
        field: 'symptom',
        quickReplies: [
          { label: 'Brak prądu', value: 'Brak prądu w części mieszkania' },
          { label: 'Iskrzy', value: 'Iskrzy lub pachnie spalenizną' },
          { label: 'Nie działa', value: 'Nie działa oświetlenie lub gniazdko' }
        ]
      }),
      field('safety', 'bezpieczeństwo', 'Czy wyłączyłeś już bezpiecznik / prąd w tym obwodzie?', {
        field: 'safety',
        quickReplies: [
          { label: 'Tak, wyłączone', value: 'Tak, wyłączyłem bezpiecznik' },
          { label: 'Nie wiem', value: 'Nie wiem, potrzebuję pomocy fachowca' }
        ]
      }),
      commonTerm
    ],
    renovation: [
      field('scope', 'zakres prac', 'Jaki zakres — jeden pokój, całe mieszkanie, powierzchnia w m²?', {
        field: 'scope',
        quickReplies: [
          { label: 'Jeden pokój', value: 'Jeden pokój do malowania' },
          { label: 'Całe mieszkanie', value: 'Całe mieszkanie' }
        ]
      }),
      commonTerm,
      field('budget', 'budżet', 'Czy masz orientacyjny budżet, czy wolisz widełki od wykonawców?', {
        priority: 'recommended',
        field: 'budget',
        quickReplies: [
          { label: 'Pokaż widełki', value: 'Ile to może kosztować?' },
          { label: 'Do 2000 zł', value: 'Mój budżet to do 2000 zł' }
        ]
      })
    ],
    cleaning: [
      field('scope', 'zakres sprzątania', 'Co dokładnie — standardowe sprzątanie, mycie okien, po remoncie?', {
        field: 'scope'
      }),
      field('area', 'metraż', 'Jaki metraż lub ile pokoi? (np. 50 m², 3 pokoje)', {
        field: 'area',
        quickReplies: [
          { label: 'Do 50 m²', value: 'Mieszkanie do 50 m²' },
          { label: '50–100 m²', value: 'Mieszkanie ok. 50–100 m²' }
        ]
      }),
      commonTerm
    ],
    installation: [
      field('item', 'co montować', 'Co mam być zamontowane — meble, drzwi, klimatyzacja, inne?', {
        field: 'item'
      }),
      commonTerm
    ],
    general: [commonTerm]
  };

  return catalogs[family] || catalogs.general;
}

function isFieldSatisfied(fieldDef, ctx, extracted, orderPayload) {
  switch (fieldDef.id) {
    case 'device_type':
      return ctx.hasDeviceType;
    case 'brand_model':
      return ctx.hasBrand && (ctx.hasModel || ctx.desc.length > 40);
    case 'symptom':
      return ctx.hasSymptom || ctx.hasErrorCode || (orderPayload.description || '').length >= 35;
    case 'photo':
      return ctx.hasPhotos;
    case 'term':
      return ctx.hasTerm;
    case 'budget':
      return ctx.hasBudget;
    case 'location_detail':
      return ctx.hasAccessInfo || /(kuchni|łazienk|lazienk|łazience|piwnic|łazience)/i.test(ctx.lower);
    case 'safety':
      return /(wyłącz|wylacz|bezpiecznik|nie dotykam)/i.test(ctx.lower);
    case 'scope':
      return ctx.hasRoomScope || (orderPayload.description || '').length >= 40;
    case 'area':
      return ctx.hasRoomScope || /\d+\s*m²|\d+\s*m2|\d+\s*pokoi/i.test(ctx.lower);
    case 'item':
      return (orderPayload.description || '').length >= 25;
    default:
      return false;
  }
}

function enrichExtractedFromContext(ctx, extracted = {}) {
  const details = [...(Array.isArray(extracted.details) ? extracted.details : [])];
  if (ctx.deviceType && !details.some((d) => d.includes(ctx.deviceType))) {
    details.push(`Urządzenie: ${ctx.deviceType}`);
  }
  if (ctx.brand && !details.some((d) => BRAND_PATTERN.test(d))) {
    details.push(`Marka: ${ctx.brand}`);
  }
  if (ctx.model && !details.some((d) => d.includes(ctx.model))) {
    details.push(`Model: ${ctx.model}`);
  }
  if (ctx.hasErrorCode) {
    const code = ctx.lower.match(ERROR_CODE_PATTERN)?.[1];
    if (code && !details.some((d) => d.includes(code))) details.push(`Kod błędu: ${code}`);
  }
  return {
    ...extracted,
    details: details.slice(0, 8),
    deviceType: ctx.deviceType || extracted.deviceType,
    brand: ctx.brand || extracted.brand,
    model: ctx.model || extracted.model
  };
}

/**
 * @param {Object} params
 * @returns {{ family, strictMode, blockers, recommended, filled, nextGap, missingLabels, enrichedExtracted }}
 */
function analyzeOrderGaps({
  messages = [],
  orderPayload = {},
  extracted = {},
  detectedService = null,
  chosenPath = null,
  lastUserText = ''
}) {
  const family = detectServiceFamily(detectedService || orderPayload.service, orderPayload.description);
  const ctx = buildContext(messages, extracted, orderPayload);
  const strictMode =
    chosenPath === 'order' ||
    ((wantsToCreateOrder(lastUserText) || wantsToCreateOrder(ctx.text)) && chosenPath !== 'providers');
  const providersSearchMode = chosenPath === 'providers';

  const catalog = getFieldCatalog(family);
  const blockers = [];
  const recommended = [];
  const filled = [];

  for (const fieldDef of catalog) {
    const ok = isFieldSatisfied(fieldDef, ctx, extracted, orderPayload);
    if (ok) {
      filled.push({ id: fieldDef.id, label: fieldDef.label });
      continue;
    }
    const asBlocker = fieldDef.priority === 'blocker' && strictMode && !providersSearchMode;
    if (asBlocker) {
      blockers.push(fieldDef);
    } else {
      recommended.push(fieldDef);
    }
  }

  const coreBlockers = [];
  if (!orderPayload.service || orderPayload.service === 'inne') {
    coreBlockers.push(
      field('service', 'kategoria usługi', 'Jaka usługa jest potrzebna?', { field: 'service' })
    );
  }
  if (!orderPayload.description || orderPayload.description.length < 10) {
    coreBlockers.push(
      field('description', 'opis problemu', 'Opisz proszę krótko, co dokładnie nie działa lub co trzeba zrobić.', {
        field: 'description'
      })
    );
  }
  if (!ctx.hasLocation && String(orderPayload.location || '').length < 2) {
    coreBlockers.push(
      field('location', 'lokalizacja', 'W jakiej lokalizacji potrzebujesz pomocy? (miasto lub dzielnica)', {
        field: 'location',
        quickReplies: [
          { label: 'Użyj mojej lokalizacji', value: 'Chcę użyć mojej aktualnej lokalizacji' }
        ]
      })
    );
  }

  const allBlockers = [...coreBlockers, ...blockers];
  const nextGap = allBlockers[0] || (strictMode ? recommended[0] : null) || null;

  return {
    family,
    strictMode,
    blockers: allBlockers,
    recommended,
    filled,
    nextGap,
    missingLabels: allBlockers.map((b) => b.label),
    enrichedExtracted: enrichExtractedFromContext(ctx, extracted)
  };
}

module.exports = {
  analyzeOrderGaps,
  detectServiceFamily,
  buildContext,
  getFieldCatalog
};
