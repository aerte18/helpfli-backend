/**
 * Offer Agent (Provider)
 * Pomoc w tworzeniu profesjonalnych ofert
 */

const { OFFER_AGENT_SYSTEM } = require('../prompts/offerAgentPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { computePriceHints } = require('../../utils/concierge');

/**
 * Główna funkcja Offer Agent
 */
async function runOfferAgent({ orderContext, providerInfo, existingOffers = [], conversationHistory = [] }) {
  try {
    const service = orderContext.service || 'inne';
    const location = orderContext.location?.city || orderContext.location || '';
    const lastProviderMessage = (conversationHistory || [])
      .filter((m) => m.role === 'user')
      .map((m) => m.content || m.text || '')
      .pop() || '';
    const assistantMode = orderContext.assistantMode || 'offer';
    const isCompanyProMode = assistantMode === 'company_pro';
    const procurementPolicy = orderContext.procurementPolicy || {};
    const wantsFollowup = assistantMode === 'followup' || /(follow|przypomn|ponowi|odezw|brak odpowiedzi|nie odpowied)/i.test(lastProviderMessage);
    const wantsSchedule = /(termin|godzin|kiedy|umów|umow|przyjazd)/i.test(lastProviderMessage);
    const wantsQuestions = assistantMode === 'risks' || /(pytan|dopyta|zapyta|brakuje|doprecyz|ryzyk)/i.test(lastProviderMessage);
    const wantsNegotiation = assistantMode === 'negotiation' || /(negocj|taniej|rabat|zniż|zniz|za drogo|obniż|obniz)/i.test(lastProviderMessage);
    
    // Oblicz sugerowaną cenę na podstawie rynku
    let priceHints = null;
    try {
      priceHints = await computePriceHints(service, {
        text: location,
        lat: orderContext.location?.lat || null,
        lon: orderContext.location?.lng || null
      });
    } catch (error) {
      console.warn('Could not compute price hints:', error.message);
    }
    
    // Określ poziom providera
    const providerLevel = providerInfo.level || providerInfo.providerTier || 'standard';
    const levelMultiplier = {
      'basic': 0.9,
      'standard': 1.0,
      'pro': 1.15
    };
    const multiplier = levelMultiplier[providerLevel] || 1.0;
    
    // Sugerowana cena na podstawie poziomu i rynku
    let suggestedPrice = null;
    if (priceHints && priceHints.standard) {
      const basePrice = (priceHints.standard.min + priceHints.standard.max) / 2;
      const adjustedPrice = Math.round(basePrice * multiplier / 10) * 10;
      suggestedPrice = {
        min: Math.round(adjustedPrice * 0.85),
        max: Math.round(adjustedPrice * 1.15),
        currency: 'PLN',
        recommended: adjustedPrice
      };
    } else {
      // Fallback widełki
      suggestedPrice = {
        min: 100,
        max: 300,
        currency: 'PLN',
        recommended: 200
      };
    }
    
    // Określ termin realizacji na podstawie pilności i terminu klienta
    const urgency = orderContext.urgency || 'standard';
    let suggestedTimeline = '';
    let suggestedCompletionDate = null;
    
    // Jeśli klient wybrał konkretny termin, użyj go jako sugestię
    if (orderContext.priorityDateTime || orderContext.clientPreferredTerm) {
      const clientTerm = new Date(orderContext.priorityDateTime || orderContext.clientPreferredTerm);
      suggestedCompletionDate = clientTerm.toISOString();
      
      // Sprawdź, czy termin jest w przyszłości
      const now = new Date();
      const daysDiff = Math.ceil((clientTerm - now) / (1000 * 60 * 60 * 24));
      
      if (daysDiff <= 0) {
        suggestedTimeline = 'Dzisiaj lub jutro (termin klienta już minął lub jest dzisiaj)';
      } else if (daysDiff === 1) {
        suggestedTimeline = 'Jutro (zgodnie z terminem klienta)';
      } else if (daysDiff <= 7) {
        suggestedTimeline = `Za ${daysDiff} dni (zgodnie z terminem klienta: ${clientTerm.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })})`;
      } else {
        suggestedTimeline = `${clientTerm.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (zgodnie z terminem klienta)`;
      }
    } else {
      // Jeśli klient nie wybrał terminu, użyj mapowania na podstawie pilności
      const timelineMap = {
        'urgent': '1-2 dni',
        'now': 'Dzisiaj',
        'today': 'Dzisiaj',
        'tomorrow': 'Jutro',
        'this_week': 'W tym tygodniu',
        'standard': '3-5 dni',
        'normal': '3-5 dni',
        'low': '1-2 tygodnie'
      };
      suggestedTimeline = timelineMap[urgency] || '3-5 dni';
    }
    
    const isPro = String(providerLevel).toLowerCase().includes('pro');
    const hasAttachments = Number(orderContext.attachments || 0) > 0;
    const hasBudget = Boolean(orderContext.budget?.min || orderContext.budget?.max || orderContext.budget);
    const hasClearDescription = (orderContext.description || '').length >= 80;
    const aiContext = orderContext.aiBrief?.contextSnapshot || null;
    const aiHandoffNote = aiContext?.handoffNote || orderContext.aiBrief?.customerSummary || '';
    const winScore = Math.max(45, Math.min(96,
      58 +
      (isPro ? 8 : 0) +
      (providerInfo.rating >= 4.5 ? 7 : 0) +
      (hasAttachments ? 6 : 0) +
      (hasBudget ? 5 : 0) +
      (urgency === 'urgent' || urgency === 'now' || urgency === 'today' ? 5 : 0) +
      (hasClearDescription ? 4 : 0)
    ));

    const risks = [
      !hasAttachments ? 'Brak zdjęć może utrudnić dokładną wycenę - zaznacz, co może zmienić cenę po oględzinach.' : null,
      !hasBudget ? 'Klient nie podał budżetu - lepiej zaproponować jasny zakres ceny lub cenę ostateczną z założeniami.' : null,
      (urgency === 'urgent' || urgency === 'now') ? 'Zlecenie jest pilne - podkreśl najbliższy realny termin i dostępność.' : null,
      (orderContext.description || '').length < 60 ? 'Opis jest krótki - zadaj 1-2 pytania przed ostatecznym zakresem.' : null
    ].filter(Boolean);

    const questions = [
      ...(Array.isArray(orderContext.aiBrief?.questionsForProvider) ? orderContext.aiBrief.questionsForProvider.slice(0, 2) : []),
      !hasAttachments ? 'Czy klient może dosłać zdjęcie problemu lub miejsca wykonania?' : null,
      'Czy cena ma obejmować materiały/części, czy tylko robociznę?',
      'Jaki termin jest dla klienta najwygodniejszy?'
    ].filter(Boolean).slice(0, 3);

    const checklist = [
      'Cena i termin są podane konkretnie',
      'Zakres prac jest jasny dla klienta',
      'Wiadomo, czy materiały i dojazd są w cenie',
      'Oferta zawiera krótki powód, dlaczego warto wybrać Ciebie',
      ...(isCompanyProMode && procurementPolicy.requiresInvoice ? ['Uwzględniono informację o fakturze VAT'] : []),
      ...(isCompanyProMode && procurementPolicy.requiresWarranty ? ['Uwzględniono zakres gwarancji'] : [])
    ];

    // Krótkie pierwsze zdanie do klienta (do karty „Komunikacja”)
    let firstMessageSuggestion = `Dzień dobry, zapoznałem się ze zleceniem i mogę pomóc${urgency === 'now' || urgency === 'today' ? ' w szybkim terminie' : ''}.`;
    
    // Generuj przykładową wiadomość
    let suggestedMessage = `${isCompanyProMode ? 'Dzień dobry, dziękuję za przesłanie zapytania.' : 'Dzień dobry! Zapoznałem się ze zleceniem i mogę je wykonać.'}

**Zakres prac:**
- ${service || 'Wykonanie usługi zgodnie z opisem'}
- diagnoza/problem zgodnie z opisem klienta
- ${aiHandoffNote ? `kontekst z rozmowy AI: ${aiHandoffNote.slice(0, 120)}` : 'potwierdzenie szczegółów przed startem'}
- robocizna i dojazd${hasAttachments ? '' : ' (dokładny zakres potwierdzę po dodatkowym zdjęciu lub krótkim opisie)'}
- uporządkowanie miejsca pracy po realizacji

**Cena:** ${suggestedPrice.recommended} PLN
**Termin realizacji:** ${suggestedTimeline}

Cena zakłada standardowy zakres prac. Jeśli po oględzinach okaże się, że potrzebne są dodatkowe części, najpierw potwierdzę to z Państwem.`;

    if (wantsFollowup) {
      firstMessageSuggestion = 'Dzień dobry, chciałem krótko wrócić do mojej oferty.';
      suggestedMessage = `Dzień dobry, chciałem krótko wrócić do mojej oferty dotyczącej zlecenia.

Podtrzymuję proponowaną cenę ${suggestedPrice.recommended} PLN i termin: ${suggestedTimeline}. Jeśli coś wymaga doprecyzowania, chętnie odpowiem na pytania albo dopasuję zakres do Państwa potrzeb.

Czy mogę zarezerwować dla Państwa najbliższy dogodny termin?`;
    } else if (wantsNegotiation) {
      firstMessageSuggestion = 'Dzień dobry, rozumiem pytanie o cenę - mogę zaproponować dwa warianty.';
      suggestedMessage = `Dzień dobry, rozumiem pytanie o cenę.

Moja propozycja ${suggestedPrice.recommended} PLN obejmuje pełny zakres: diagnozę, robociznę, dojazd i uporządkowanie miejsca pracy. Mogę też przygotować tańszy wariant, jeśli ograniczymy zakres lub materiały/części rozliczymy osobno.

Proponuję:
1. Wariant pełny: ${suggestedPrice.recommended} PLN
2. Wariant podstawowy: do ustalenia po doprecyzowaniu zakresu

Chętnie dopasuję rozwiązanie tak, żeby było uczciwe cenowo i bez niespodzianek.`;
    } else if (wantsSchedule) {
      firstMessageSuggestion = 'Dzień dobry, proponuję ustalić dogodny termin realizacji.';
      suggestedMessage = `Dzień dobry, proponuję ustalić dogodny termin realizacji.

Z mojej strony realny termin to: ${suggestedTimeline}. Przed przyjazdem mogę jeszcze potwierdzić zakres prac i ewentualne materiały/części.

Jaki dzień i godzina będą dla Państwa najwygodniejsze?`;
    } else if (wantsQuestions) {
      firstMessageSuggestion = 'Dzień dobry, zanim potwierdzę finalny zakres, mam krótkie pytania.';
      suggestedMessage = `Dzień dobry, zanim potwierdzę finalny zakres i cenę, potrzebuję krótkiego doprecyzowania:

${questions.map((q, index) => `${index + 1}. ${q}`).join('\n')}

Po odpowiedzi przygotuję konkretną realizację i termin.`;
    }
    
    // Wskazówki
    const tips = [
      aiHandoffNote ? 'Użyj kontekstu z rozmowy AI - klient nie powinien powtarzać tych samych informacji.' : null,
      isCompanyProMode && procurementPolicy.requiresInvoice ? 'Dodaj informację o możliwości wystawienia faktury VAT.' : null,
      isCompanyProMode && procurementPolicy.requiresWarranty ? 'Wprost opisz zakres gwarancji i czas jej obowiązywania.' : null,
      'Bądź konkretny w opisie zakresu prac',
      'Zaproponuj kilka opcji cenowych jeśli możliwe',
      'Zapytaj o dodatkowe szczegóły jeśli potrzebne',
      'Odpowiedz szybko - to zwiększa szanse na akceptację'
    ].filter(Boolean);
    
    // Zakres prac
    const suggestedScope = [
      `Realizacja usługi: ${service || 'zgodnie z opisem'}`,
      'Konsultacja i wycena na miejscu',
      'Terminowa realizacja',
      'Gwarancja jakości wykonania'
    ];
    
    // Porównanie z konkurencją
    const competition = {
      averagePrice: priceHints?.standard ? (priceHints.standard.min + priceHints.standard.max) / 2 : suggestedPrice.recommended,
      priceRange: priceHints?.standard || suggestedPrice,
      note: `Twoja cena jest ${suggestedPrice.recommended < (priceHints?.standard?.min || 200) ? 'konkurencyjna' : 'w zakresie rynkowym'}`
    };
    
    // Dodaj wskazówkę o terminie klienta do tips
    if (orderContext.priorityDateTime || orderContext.clientPreferredTerm) {
      tips.unshift('Klient wybrał konkretny termin - zaproponuj ten sam termin lub bardzo zbliżony, aby zwiększyć szanse na akceptację');
    }
    
    return {
      ok: true,
      agent: 'offer',
      suggestedPrice,
      suggestedTimeline,
      suggestedCompletionDate,
      suggestedMessage: suggestedMessage.slice(0, 500),
      suggestedDescription: suggestedMessage.slice(0, 500),
      firstMessageSuggestion,
      suggestedScope: suggestedScope.slice(0, 5),
      tips: tips.slice(0, 4),
      competition,
      winScore,
      winLabel: winScore >= 82 ? 'Bardzo mocna oferta' : winScore >= 68 ? 'Dobra szansa' : 'Wymaga doprecyzowania',
      risks: risks.slice(0, 3),
      questions,
      checklist,
      recommendedIncludes: hasAttachments ? ['labor', 'transport'] : ['labor', 'transport'],
      recommendedContactMethod: urgency === 'now' || urgency === 'today' ? 'call_before' : 'chat_only',
      isFinalPriceRecommended: hasAttachments && hasClearDescription,
      missing: risks.slice(0, 3)
    };
    
  } catch (error) {
    console.error('Offer Agent error:', error);
    
    return {
      ok: false,
      agent: 'offer',
      suggestedPrice: { min: 100, max: 300, currency: 'PLN', recommended: 200 },
      suggestedTimeline: '3-5 dni',
      suggestedMessage: 'Witam! Zapoznałem się z opisem zlecenia i chętnie pomogę.',
      firstMessageSuggestion: 'Witam! Zapoznałem się z opisem i chętnie pomogę.',
      suggestedScope: ['Realizacja usługi zgodnie z opisem'],
      tips: ['Bądź profesjonalny i konkretny'],
      competition: { averagePrice: 200, priceRange: { min: 150, max: 250 }, note: 'Sprawdź lokalne ceny' },
      missing: [],
      questions: []
    };
  }
}

module.exports = {
  runOfferAgent
};

