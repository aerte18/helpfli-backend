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
    
    // Krótkie pierwsze zdanie do klienta (do karty „Komunikacja”)
    const firstMessageSuggestion = `Witam! Zapoznałem się z opisem zlecenia i chętnie pomogę – mogę zrealizować w podanym terminie.`;
    
    // Generuj przykładową wiadomość
    const suggestedMessage = `Witam! Zapoznałem się z opisem zlecenia i chętnie pomogę.

**Zakres prac:**
- ${service || 'Wykonanie usługi zgodnie z opisem'}
- Pełna realizacja w terminie
- Gwarancja jakości

**Cena:** ${suggestedPrice.recommended} PLN
**Termin realizacji:** ${suggestedTimeline}

Jestem gotowy rozpocząć pracę. Czy mogę zadać kilka pytań dotyczących szczegółów?`;
    
    // Wskazówki
    const tips = [
      'Bądź konkretny w opisie zakresu prac',
      'Zaproponuj kilka opcji cenowych jeśli możliwe',
      'Zapytaj o dodatkowe szczegóły jeśli potrzebne',
      'Odpowiedz szybko - to zwiększa szanse na akceptację'
    ];
    
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
      firstMessageSuggestion,
      suggestedScope: suggestedScope.slice(0, 5),
      tips: tips.slice(0, 4),
      competition,
      missing: [],
      questions: []
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

