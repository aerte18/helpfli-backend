// services/claude.js
// Integracja z Claude 3.5 API

const Anthropic = require('@anthropic-ai/sdk');
const webSearchService = require('./web_search');

class ClaudeService {
  constructor() {
    this.client = null;
    this.isEnabled = false;
    this.webSearchEnabled = webSearchService.getStatus().providers.bing.enabled || 
                           webSearchService.getStatus().providers.serpapi.enabled ||
                           webSearchService.getStatus().providers.perplexity.enabled;
    this.initialize();
  }

  initialize() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        this.client = new Anthropic({
          apiKey: apiKey,
        });
        this.isEnabled = true;
        console.log('✅ Claude 3.5 API initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize Claude API:', error.message);
        this.isEnabled = false;
      }
    } else {
      console.log('⚠️ Claude API disabled - no ANTHROPIC_API_KEY found');
      this.isEnabled = false;
    }
  }

  async analyzeWithClaude({ description, imageUrls = [], lang = 'pl', enableWebSearch = false, priceHints = null, locationText = null, similarOrders = [], successfulFeedback = [], availableParts = [], cityMultiplier = null, conversationHistory = [] }) {
    if (!this.isEnabled) {
      throw new Error('Claude API is not enabled');
    }

    try {
      // Wykryj kategorię z opisu, aby dostosować prompt
      const detectedCategory = this.detectCategoryFromDescription(description);
      
      // Przygotuj prompt w zależności od języka i kategorii
      const isConversation = conversationHistory && conversationHistory.length > 0;
      const systemPrompt = lang === 'en' 
        ? this.getEnglishSystemPrompt(detectedCategory, isConversation)
        : this.getPolishSystemPrompt(detectedCategory, isConversation);

      // Załaduj katalog części zamiennych dla danej kategorii
      const { findPartsByNameOrType, getCityPricingMultiplier } = require('../utils/concierge');
      const availableParts = detectedCategory ? findPartsByNameOrType('', detectedCategory) : [];
      
      // Określ mnożnik cenowy dla lokalizacji
      const cityMultiplier = locationText ? getCityPricingMultiplier(locationText) : null;
      
      // Przygotuj wiadomość użytkownika z kontekstem kategorii, cen, podobnych zleceń, feedbacku, części i lokalizacji
      let userMessage = this.buildUserMessage(description, imageUrls, detectedCategory, priceHints, locationText, similarOrders, successfulFeedback, availableParts, cityMultiplier, conversationHistory);

      // Dodaj wyszukiwanie internetowe jeśli włączone
      if (enableWebSearch && this.webSearchEnabled) {
        try {
          console.log('🔍 Performing web search for context...');
          const webResults = await webSearchService.searchServiceInfo(
            this.extractServiceFromDescription(description),
            null
          );
          
          if (webResults.length > 0) {
            const webContext = this.formatWebSearchResults(webResults);
            userMessage.content.push({
              type: 'text',
              text: `\n\nDodatkowe informacje z internetu:\n${webContext}`
            });
          }
        } catch (error) {
          console.warn('Web search failed, continuing without context:', error.message);
        }
      }

      console.log('🤖 Claude API request:', { 
        description: description.substring(0, 100) + '...', 
        imageCount: imageUrls.length,
        lang,
        webSearchEnabled: enableWebSearch && this.webSearchEnabled
      });

      // Przygotuj historię konwersacji
      const messages = [];
      
      // Jeśli mamy historię konwersacji, dodaj ją (ostatnie 10 wiadomości, żeby nie przekroczyć limitów)
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-10); // Ostatnie 10 wiadomości
        recentHistory.forEach(msg => {
          if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({
              role: msg.role,
              content: typeof msg.text === 'string' ? msg.text : JSON.stringify(msg.text)
            });
          }
        });
      }
      
      // Dodaj aktualną wiadomość użytkownika
      messages.push(userMessage);

      const response = await this.client.messages.create({
        model: process.env.CLAUDE_DEFAULT || 'claude-sonnet-4-6',
        max_tokens: 4000,
        temperature: 0.3,
        system: systemPrompt,
        messages: messages
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const result = this.parseClaudeResponse(content.text);
      
      // Dodaj naturalną odpowiedź tekstową dla konwersacji (jeśli nie jest to pierwsza wiadomość lub jeśli użytkownik pyta o coś konkretnego)
      // W konwersacji, odpowiedź tekstowa jest ważniejsza niż strukturyzowane dane
      if (conversationHistory.length > 0 || result.conversationText) {
        // Jeśli to kontynuacja konwersacji, użyj surowej odpowiedzi jako tekstu konwersacyjnego
        result.conversationText = result.conversationText || content.text.substring(0, 2000); // Ogranicz do 2000 znaków
      } else {
        // W pierwszej wiadomości, wygeneruj naturalną odpowiedź na podstawie strukturyzowanych danych
        result.conversationText = this.generateConversationalResponse(result);
      }
      
      console.log('✅ Claude API response received');
      
      return result;
    } catch (error) {
      console.error('❌ Claude API error:', error.message);
      throw error;
    }
  }

  detectCategoryFromDescription(description) {
    const desc = (description || '').toLowerCase();
    
    // Hydraulika
    if (/(kran|bateria|zlew|woda|cieknie|wyciek|kanalizacja|udrażnianie|wc|spłuczka|grzejnik|termostat|odpowietrzanie|instalacja.*wod|hydraulik)/.test(desc)) {
      return 'hydraulika';
    }
    
    // Elektryka
    if (/(prąd|elektryk|gniazdko|włącznik|oświetlenie|led|instalacja.*elektryczn|bezpiecznik|zwarcie|iskr|kabel|przewód|elektryczn)/.test(desc)) {
      return 'elektryka';
    }
    
    // IT/Komputery
    if (/(komputer|laptop|drukarka|sieć|wifi|router|internet|oprogramowanie|aplikacja|telefon|smartfon|tablet|it|informatyk)/.test(desc)) {
      return 'it';
    }
    
    // Remont/Budowa
    if (/(remont|budowa|malowanie|tapetowanie|płytki|gładź|tynk|fugowanie|podłoga|parkiet|drzwi|okno|montaż|demontaż)/.test(desc)) {
      return 'remont';
    }
    
    // Ogrodnictwo
    if (/(ogród|trawa|koszenie|drzewo|krzew|roślina|nawadnianie|system.*nawadniania|ogrodnik)/.test(desc)) {
      return 'ogrodnictwo';
    }
    
    // Sprzątanie
    if (/(sprzątanie|czyszczenie|porządki|mycie|odkurzanie|pranie|prasowanie)/.test(desc)) {
      return 'sprzątanie';
    }
    
    // Transport/Przeprowadzka
    if (/(przeprowadzka|transport|przenoszenie|pakowanie|rozpakowanie|przewóz)/.test(desc)) {
      return 'transport';
    }
    
    // Inne
    return 'inne';
  }

  getCategorySpecificInstructions(category) {
    const instructions = {
      hydraulika: `
SPECJALIZACJA: HYDRAULIKA
- Zwróć szczególną uwagę na: wycieki wody, ciśnienie, jakość wody, stan instalacji
- Typowe problemy: cieknące krany, zatkane odpływy, niskie ciśnienie, hałas w instalacji
- Części zamienne: uszczelki, zawory, głowice baterii, węże, filtry
- BEZPIECZEŃSTWO I PRZEPISY:
  * Zawsze wyłącz główny zawór wody przed naprawą (norma PN-EN 806)
  * Sprawdź ciśnienie wody (norma: 0,2-0,6 MPa dla instalacji domowych)
  * Używaj odpowiednich narzędzi (klucze nastawne, nie szczypce)
  * Sprawdź czy instalacja nie jest pod napięciem (ryzyko porażenia przez wodę)
  * W przypadku wycieku gazu - natychmiast zakręć zawór, wywietrz pomieszczenie, nie używaj urządzeń iskrzących
  * Zgodnie z przepisami BHP: używaj rękawic ochronnych, okularów ochronnych przy cięciu rur
  * Instalacje gazowe wymagają uprawnień - NIE naprawiaj samodzielnie!
- Ceny w Polsce: naprawa kranu 80-200 zł, udrażnianie 150-400 zł, wymiana baterii 200-500 zł
- Czas realizacji: proste naprawy 1-2h, kompleksowe 4-8h
`,
      elektryka: `
SPECJALIZACJA: ELEKTRYKA
- Zwróć szczególną uwagę na: bezpieczeństwo, napięcie, obciążenie, stan instalacji
- Typowe problemy: brak prądu, iskrzenie, przegrzewanie, miganie światła, zwarcia
- Części zamienne: bezpieczniki, gniazdka, włączniki, kable, oprawy LED
- BEZPIECZEŃSTWO I PRZEPISY (KRYTYCZNE):
  * ⚠️ NIGDY nie dotykaj instalacji pod napięciem! Zawsze wyłącz bezpiecznik główny przed pracą
  * Zgodnie z normą PN-IEC 60364: sprawdź czy instalacja jest odłączona od zasilania (użyj próbnika napięcia)
  * Wymagane uprawnienia SEP (Stowarzyszenie Elektryków Polskich) dla prac powyżej 1kV
  * Normy PN-EN 60364 (instalacje elektryczne niskiego napięcia)
  * BHP: używaj narzędzi z izolacją, rękawic dielektrycznych, okularów ochronnych
  * W przypadku zwarcia/iskrzenia: wyłącz bezpiecznik, nie gas wodą (ryzyko porażenia!)
  * Instalacje trójfazowe (380V) - wymagają uprawnień SEP, NIE naprawiaj samodzielnie!
  * Gniazdka w łazience/kuchni - wymagają ochrony IP44 (norma PN-EN 60529)
  * Uziemienie - obowiązkowe dla wszystkich gniazdek (norma PN-HD 60364-4-41)
- Ceny w Polsce: montaż gniazdka 80-150 zł, wymiana bezpiecznika 50-100 zł, kompleksowa instalacja 500-2000 zł
- Czas realizacji: proste naprawy 1-3h, kompleksowe 4-8h
`,
      it: `
SPECJALIZACJA: IT/KOMPUTERY
- Zwróć szczególną uwagę na: system operacyjny, model urządzenia, błędy, konfigurację
- Typowe problemy: wolny komputer, brak internetu, problemy z drukarką, wirusy, aktualizacje
- Części zamienne: kable, zasilacze, dyski, pamięć RAM, karty sieciowe
- BEZPIECZEŃSTWO I PRZEPISY:
  * Zawsze wykonaj backup danych przed naprawą (RODO - ochrona danych osobowych)
  * Używaj zasilaczy zgodnych z normą CE (oznaczenie na zasilaczu)
  * Kable zasilające - sprawdź czy mają oznaczenie CE i odpowiednią grubość (norma PN-EN 50525)
  * Ochrona przed wirusami - używaj legalnego oprogramowania antywirusowego
  * Bezpieczne hasła - minimum 12 znaków, różne znaki (norma PN-ISO/IEC 27001)
  * Nie otwieraj urządzeń pod napięciem - wyłącz z gniazdka przed demontażem
  * Dysk twardy - usuń dane zgodnie z RODO przed oddaniem do naprawy
  * Zgodnie z przepisami: naprawa urządzeń z danymi osobowymi wymaga zachowania poufności
- Ceny w Polsce: diagnostyka 100-200 zł, naprawa 150-500 zł, instalacja oprogramowania 80-200 zł
- Czas realizacji: diagnostyka 1-2h, naprawa 2-6h, instalacja 1-3h
`,
      remont: `
SPECJALIZACJA: REMONT/BUDOWA
- Zwróć szczególną uwagę na: powierzchnię, stan podłoża, materiały, kolory, style
- Typowe problemy: pęknięcia, odpadanie, przebarwienia, wilgoć, nierówności
- Materiały: farby, tapety, płytki, kleje, fugi, gładzie, tynki
- BEZPIECZEŃSTWO I PRZEPISY:
  * Wentylacja - obowiązkowa przy malowaniu (norma PN-EN 13779) - minimum 0,5 wymiany powietrza/h
  * Ochrona dróg oddechowych - używaj masek przeciwpyłowych przy szlifowaniu (norma PN-EN 149)
  * Ochrona oczu - okulary ochronne przy cięciu, szlifowaniu (norma PN-EN 166)
  * Rusztowania - stabilne, zgodne z normą PN-EN 12811, maksymalne obciążenie zgodne z instrukcją
  * Farby i rozpuszczalniki - przechowuj w dobrze wentylowanym miejscu, z dala od źródeł ognia
  * Prace na wysokości powyżej 1m - wymagają zabezpieczeń (norma PN-EN 795)
  * Azbest - jeśli podejrzewasz obecność azbestu, NIE usuwaj samodzielnie! Wymaga specjalistycznej firmy
  * Ochrona przed upadkiem - używaj pasów bezpieczeństwa przy pracach na dachu/wysokości
  * BHP: odpowiednie obuwie (ochrona przed poślizgiem), rękawice ochronne, kask na budowie
- Ceny w Polsce: malowanie 15-40 zł/m², układanie płytek 40-80 zł/m², gładź 20-35 zł/m²
- Czas realizacji: małe pomieszczenia 1-2 dni, średnie 3-5 dni, duże 1-2 tygodnie
`,
      ogrodnictwo: `
SPECJALIZACJA: OGRODNICTWO
- Zwróć szczególną uwagę na: porę roku, rodzaj roślin, stan gleby, nawodnienie
- Typowe problemy: chore rośliny, chwasty, sucha trawa, uszkodzone drzewa, system nawadniania
- Materiały: nasiona, nawozy, ziemia, narzędzia, systemy nawadniania
- BEZPIECZEŃSTWO I PRZEPISY:
  * Ochrona przed słońcem - używaj kremu z filtrem SPF 30+, nakrycia głowy
  * Narzędzia - sprawdź czy są ostre i w dobrym stanie, przechowuj bezpiecznie
  * Środki chemiczne - używaj zgodnie z instrukcją, w rękawicach, z dala od dzieci (norma PN-EN 15695)
  * Kosiarki i pilarki - sprawdź przed użyciem, używaj ochrony słuchu i oczu (norma PN-EN 60335)
  * Prace na drzewach - powyżej 3m wymagają specjalistycznego sprzętu i uprawnień
  * System nawadniania - sprawdź ciśnienie wody, używaj odpowiednich złączek (norma PN-EN 12201)
  * Nawozy - przechowuj w oryginalnych opakowaniach, z dala od żywności
  * BHP: odpowiednie obuwie (ochrona przed urazami), rękawice ogrodnicze, okulary ochronne
- Ceny w Polsce: koszenie trawy 50-150 zł, przycinanie drzew 200-800 zł, projekt ogrodu 500-2000 zł
- Czas realizacji: koszenie 1-2h, przycinanie 2-4h, kompleksowa pielęgnacja 4-8h
`,
      sprzątanie: `
SPECJALIZACJA: SPRZĄTANIE
- Zwróć szczególną uwagę na: powierzchnię, rodzaj zabrudzenia, materiały czyszczące
- Typowe problemy: trudne plamy, zapachy, kurz, wilgoć, pleśń
- Materiały: środki czyszczące, gąbki, ścierki, odkurzacze, parownice
- Bezpieczeństwo: wentylacja, ochrona skóry, odpowiednie środki do powierzchni
- Ceny w Polsce: sprzątanie mieszkania 80-150 zł, biura 150-300 zł, po remoncie 200-500 zł
- Czas realizacji: małe mieszkanie 2-4h, średnie 4-6h, duże 6-8h
`,
      transport: `
SPECJALIZACJA: TRANSPORT/PRZEPROWADZKA
- Zwróć szczególną uwagę na: odległość, gabaryty, wartość przedmiotów, dostępność
- Typowe problemy: brak transportu, duże przedmioty, delikatne rzeczy, organizacja
- Materiały: kartony, folia, taśmy, ochrona narożników, wózki
- Bezpieczeństwo: odpowiednie zabezpieczenie, ubezpieczenie, pomoc przy ciężkich przedmiotach
- Ceny w Polsce: transport lokalny 150-300 zł, między miastami 300-800 zł, pełna przeprowadzka 1000-5000 zł
- Czas realizacji: mały transport 2-4h, średni 4-6h, pełna przeprowadzka 1-2 dni
`,
      inne: `
SPECJALIZACJA: INNE USŁUGI
- Zwróć szczególną uwagę na: specyfikę problemu, dostępność wykonawców, lokalne ceny
- Bezpieczeństwo: zawsze sprawdź wymagania bezpieczeństwa dla danej usługi
- Ceny w Polsce: zależą od specyfiki usługi, sprawdź lokalne widełki cenowe
- Czas realizacji: zależy od złożoności problemu
`
    };
    
    return instructions[category] || instructions.inne;
  }

  getPolishSystemPrompt(category = 'inne', isConversation = false) {
    const categoryInstructions = this.getCategorySpecificInstructions(category);
    
    const conversationNote = isConversation 
      ? `\n\nWAŻNE - KONWERSACJA:\nJeśli to kontynuacja rozmowy (masz historię konwersacji), odpowiadaj naturalnie i konwersacyjnie, jak żywy ekspert. Nie musisz za każdym razem generować pełnej struktury JSON - skup się na odpowiedzi na pytanie użytkownika. Jeśli użytkownik zadaje pytanie uzupełniające, odpowiadaj bezpośrednio na nie, zachowując kontekst poprzedniej rozmowy.`
      : '';
    
    return `Jesteś ekspertem w analizie problemów domowych i biznesowych w Polsce. Twoim zadaniem jest:${conversationNote}

${categoryInstructions}

1. ANALIZA PROBLEMU (w tym obrazów/filmów):
   - Jeśli otrzymasz zdjęcia/filmy, dokładnie przeanalizuj co na nich widać
   - Określ kategorię usługi na podstawie wizualnej analizy (np. hydraulika, elektryka, remont, ogrodnictwo, IT, sprzątanie)
   - Oszacuj poziom ryzyka (low/medium/high) na podstawie tego co widzisz
   - Zaproponuj pilność (normal/today/now) w zależności od problemu
   - Zidentyfikuj potencjalne zagrożenia widoczne na zdjęciach

2. KROKI DIY:
   - Zaproponuj 2-3 bezpieczne kroki, które użytkownik może wykonać sam
   - Uwzględnij polskie standardy i przepisy
   - Ostrzeż przed niebezpiecznymi działaniami
   - Jeśli widzisz na zdjęciu coś niebezpiecznego, szczególnie to podkreśl

3. REKOMENDACJE:
   - Zaproponuj typ wykonawcy (firma/indywidualny) na podstawie złożoności problemu
   - Oszacuj orientacyjny koszt w PLN na podstawie tego co widzisz
   - Zaproponuj czas realizacji
   - Jeśli problem wymaga natychmiastowej interwencji, zaznacz to w urgency

4. WYKRYWANIE POTRZEB WYNAJMU/KUPNA I ALTERNATYW:
   - Jeśli użytkownik wspomina o potrzebie wynajęcia sprzętu (betoniarka, wibrator, szlifierka, dźwig, koparka, itp.) → ustaw "needsEquipment": true
   - Jeśli użytkownik wspomina o potrzebie kupna części (zawory, głowice, gniazdka, kable, itp.) → ustaw "needsParts": true
   - WAŻNE: Jeśli użytkownik chce KUPIĆ sprzęt, który można WYNAJĄĆ (np. kosiarka, betoniarka, wibrator) → ustaw "wantsToBuyEquipment": true i "suggestRentalAlternative": true
   - W polu "equipmentType" lub "partsType" wpisz konkretny typ sprzętu/części
   - To pozwoli systemowi znaleźć odpowiednie ogłoszenia od wykonawców i zasugerować alternatywy (wynajem zamiast kupna)

Odpowiedz w formacie JSON:
{
  "serviceCandidate": {
    "code": "kod_uslugi",
    "name": "Nazwa usługi",
    "confidence": 0.95
  },
  "deviceIdentification": {
    "brand": "Marka urządzenia (jeśli widoczna)",
    "model": "Model urządzenia (jeśli widoczny)",
    "type": "Typ urządzenia/elementu",
    "serialNumber": "Numer seryjny (jeśli widoczny)",
    "parts": ["lista", "konkretnych", "części", "widocznych", "na", "zdjęciu"]
  },
  "conditionAssessment": {
    "overallCondition": "new|good|fair|poor|very_poor",
    "visibleDamage": ["lista", "widocznych", "uszkodzeń"],
    "wearLevel": "low|medium|high",
    "estimatedAge": "szacowany wiek w latach lub 'unknown'"
  },
  "diySteps": [
    {
      "title": "Tytuł kroku",
      "description": "Opis kroku",
      "safety": "safe|caution|danger"
    }
  ],
  "requiredParts": [
    {
      "name": "Nazwa części",
      "type": "Typ części",
      "specification": "Specyfikacja (rozmiar, model, etc.)",
      "estimatedPrice": 50,
      "currency": "PLN"
    }
  ],
  "dangerFlags": ["lista", "zagrożeń"],
  "urgency": "normal|today|now",
  "estimatedCost": {
    "min": 100,
    "max": 500,
    "currency": "PLN",
    "breakdown": {
      "labor": 200,
      "parts": 150,
      "other": 50
    }
  },
  "estimatedTime": "1-2 dni",
  "providerType": "company|individual|both",
  "needsEquipment": true|false,
  "needsParts": true|false,
  "wantsToBuyEquipment": true|false,  // Czy użytkownik chce KUPIĆ sprzęt (można zasugerować wynajem)
  "suggestRentalAlternative": true|false,  // Czy zasugerować wynajem zamiast kupna
  "equipmentType": "betoniarka|wibrator|szlifierka|kosiarka|...",
  "partsType": "zawór|głowica|gniazdko|..."
}`;
  }

  getEnglishSystemPrompt(category = 'inne') {
    const categoryInstructions = this.getCategorySpecificInstructions(category);
    
    return `You are an expert in analyzing home and business problems in Poland. Your task is to:

${categoryInstructions}

1. PROBLEM ANALYSIS (including images/videos):
   - If you receive photos/videos, carefully analyze what is visible
   - Determine service category based on visual analysis (e.g., plumbing, electrical, renovation, gardening, IT, cleaning)
   - Assess risk level (low/medium/high) based on what you see
   - Suggest urgency (normal/today/now) depending on the problem
   - Identify potential hazards visible in photos

2. DIY STEPS:
   - Suggest 2-3 safe steps the user can take themselves
   - Consider Polish standards and regulations
   - Warn against dangerous actions
   - If you see something dangerous in the photo, especially emphasize it

3. RECOMMENDATIONS:
   - Suggest contractor type (company/individual) based on problem complexity
   - Estimate approximate cost in PLN based on what you see
   - Suggest completion time
   - If the problem requires immediate intervention, mark it in urgency

4. DETECTING RENTAL/PURCHASE NEEDS AND ALTERNATIVES:
   - If the user mentions needing to rent equipment (concrete mixer, vibrator, grinder, crane, excavator, etc.) → set "needsEquipment": true
   - If the user mentions needing to buy parts (valves, faucet heads, sockets, cables, etc.) → set "needsParts": true
   - IMPORTANT: If the user wants to BUY equipment that can be RENTED (e.g., lawn mower, concrete mixer, vibrator) → set "wantsToBuyEquipment": true and "suggestRentalAlternative": true
   - In "equipmentType" or "partsType" field, specify the exact type of equipment/parts
   - This will allow the system to find relevant announcements from providers and suggest alternatives (rental instead of purchase)

Respond in JSON format:
{
  "serviceCandidate": {
    "code": "service_code",
    "name": "Service name",
    "confidence": 0.95
  },
  "deviceIdentification": {
    "brand": "Device brand (if visible)",
    "model": "Device model (if visible)",
    "type": "Device/element type",
    "serialNumber": "Serial number (if visible)",
    "parts": ["list", "of", "specific", "parts", "visible", "in", "photo"]
  },
  "conditionAssessment": {
    "overallCondition": "new|good|fair|poor|very_poor",
    "visibleDamage": ["list", "of", "visible", "damages"],
    "wearLevel": "low|medium|high",
    "estimatedAge": "estimated age in years or 'unknown'"
  },
  "diySteps": [
    {
      "title": "Step title",
      "description": "Step description",
      "safety": "safe|caution|danger"
    }
  ],
  "requiredParts": [
    {
      "name": "Part name",
      "type": "Part type",
      "specification": "Specification (size, model, etc.)",
      "estimatedPrice": 50,
      "currency": "PLN"
    }
  ],
  "dangerFlags": ["list", "of", "hazards"],
  "urgency": "normal|today|now",
  "estimatedCost": {
    "min": 100,
    "max": 500,
    "currency": "PLN",
    "breakdown": {
      "labor": 200,
      "parts": 150,
      "other": 50
    }
  },
  "estimatedTime": "1-2 days",
  "providerType": "company|individual|both",
  "needsEquipment": true|false,
  "needsParts": true|false,
  "wantsToBuyEquipment": true|false,  // Does the user want to BUY equipment (can suggest rental)
  "suggestRentalAlternative": true|false,  // Should suggest rental instead of purchase
  "equipmentType": "concrete mixer|vibrator|grinder|lawn mower|...",
  "partsType": "valve|faucet head|socket|..."
  "needsEquipment": true|false,  // Czy użytkownik potrzebuje wynająć sprzęt?
  "needsParts": true|false,      // Czy użytkownik potrzebuje kupić części?
  "equipmentType": "betoniarka|wibrator|szlifierka|...",  // Typ sprzętu jeśli potrzebny
  "partsType": "zawór|głowica|gniazdko|..."  // Typ części jeśli potrzebny
}`;
  }

  buildUserMessage(description, imageUrls, category = null, priceHints = null, locationText = null, similarOrders = [], successfulFeedback = [], availableParts = [], cityMultiplier = null, conversationHistory = []) {
    // Jeśli to kontynuacja konwersacji, nie dodawaj wszystkich kontekstów ponownie (tylko w pierwszej wiadomości)
    const isFirstMessage = conversationHistory.length === 0;
    
    let textContent = isFirstMessage ? `Opisz problem: ${description}` : description;
    
    // Dodaj kontekst tylko w pierwszej wiadomości (żeby nie powtarzać w każdej odpowiedzi)
    if (isFirstMessage) {
      // Dodaj kontekst lokalizacji jeśli dostępny
      if (locationText) {
        textContent += `\n\nLokalizacja: ${locationText}`;
        
        // Dodaj informacje o mnożniku cenowym dla miasta
        if (cityMultiplier && cityMultiplier.multiplier && cityMultiplier.multiplier !== 1.0) {
          const percentage = Math.round((cityMultiplier.multiplier - 1) * 100);
          textContent += `\n\n⚠️ KONTEKST LOKALIZACYJNY - CENY:`;
          if (cityMultiplier.city) {
            textContent += `\n- Miasto: ${cityMultiplier.city}`;
          }
          textContent += `\n- Mnożnik cenowy: ${cityMultiplier.multiplier.toFixed(2)}x (ceny są o ~${percentage}% wyższe niż średnia krajowa)`;
          if (cityMultiplier.description) {
            textContent += `\n- Uzasadnienie: ${cityMultiplier.description}`;
          }
          textContent += `\n- WAŻNE: Przy szacowaniu kosztów uwzględnij ten mnożnik - ceny w tym mieście są wyższe niż średnia krajowa.`;
        } else if (locationText && !cityMultiplier?.city) {
          textContent += `\n\nℹ️ KONTEKST LOKALIZACYJNY:`;
          textContent += `\n- Lokalizacja: ${locationText}`;
          textContent += `\n- Uwaga: To mniejsze miasto/wieś - ceny mogą być nieco niższe niż w dużych miastach (Warszawa, Kraków).`;
        }
      }
      
      // Dodaj kontekst cenowy jeśli dostępny
      if (priceHints) {
        const min = priceHints.min || priceHints.stats?.adjusted?.min;
        const med = priceHints.med || priceHints.stats?.adjusted?.med;
        const max = priceHints.max || priceHints.stats?.adjusted?.max;
        
        if (min && max) {
          textContent += `\n\nKONTEKST CENOWY (z historii podobnych zleceń w tej lokalizacji):`;
          textContent += `\n- Widełki cenowe: ${min}-${max} PLN`;
          if (med) {
            textContent += `\n- Średnia cena: ${med} PLN`;
          }
          textContent += `\n- Użyj tych widełek jako referencji przy szacowaniu kosztów, ale dostosuj je do konkretnego problemu`;
        }
      }
      
      // Dodaj podobne zlecenia z historii jako kontekst
      if (similarOrders && similarOrders.length > 0) {
        textContent += `\n\nPODOBNE ZLECENIA Z HISTORII (zakończone sukcesem):`;
        similarOrders.forEach((order, idx) => {
          textContent += `\n\n${idx + 1}. Opis: "${order.description.substring(0, 150)}${order.description.length > 150 ? '...' : ''}"`;
          textContent += `\n   Lokalizacja: ${order.location}`;
          if (order.price) {
            textContent += `\n   Cena: ${order.price} PLN`;
          }
          textContent += `\n   Podobieństwo: ${order.similarity}%`;
        });
        textContent += `\n\nUżyj tych przykładów jako referencji - zobacz jak podobne problemy były rozwiązane i jakie były ich koszty.`;
      }
      
      // Dodaj feedback z podobnych problemów, które zadziałały
      if (successfulFeedback && successfulFeedback.length > 0) {
        textContent += `\n\n✅ SPRAWDZONE ROZWIĄZANIA (z feedbacku użytkowników - zadziałały!):`;
        successfulFeedback.forEach((fb, idx) => {
          textContent += `\n\n${idx + 1}. Problem: "${fb.description.substring(0, 120)}${fb.description.length > 120 ? '...' : ''}"`;
          textContent += `\n   Lokalizacja: ${fb.location || 'Nieznana'}`;
          textContent += `\n   Ocena użytkownika: ${fb.rating}/5 ⭐`;
          if (fb.actualCost) {
            textContent += `\n   Rzeczywisty koszt: ${fb.actualCost} PLN`;
          }
          if (fb.actualTime) {
            textContent += `\n   Rzeczywisty czas: ${fb.actualTime}`;
          }
          if (fb.usedParts && fb.usedParts.length > 0) {
            textContent += `\n   Użyte części: ${fb.usedParts.map(p => p.name).join(', ')}`;
          }
          if (fb.solution?.diySteps && fb.solution.diySteps.length > 0) {
            textContent += `\n   Kroki które zadziałały: ${fb.solution.diySteps.slice(0, 2).map(s => typeof s === 'string' ? s : s.text || s.title).join('; ')}`;
          }
          textContent += `\n   Podobieństwo: ${fb.similarity}%`;
        });
        textContent += `\n\nWAŻNE: Te rozwiązania zostały przetestowane przez użytkowników i zadziałały! Użyj ich jako wzorca przy proponowaniu rozwiązania.`;
      }
    }
    
    // Jeśli są obrazy, dodaj szczegółowe instrukcje do analizy (tylko w pierwszej wiadomości)
    if (imageUrls && imageUrls.length > 0 && isFirstMessage) {
      textContent += `\n\n=== SZCZEGÓŁOWA ANALIZA OBRAZÓW ===`;
      textContent += `\n\nPrzeanalizuj załączone zdjęcia/filmy bardzo dokładnie i na ich podstawie:`;
      
      textContent += `\n\n1. IDENTYFIKACJA URZĄDZENIA/ELEMENTU:`;
      textContent += `\n- Zidentyfikuj markę i model urządzenia/elementu (jeśli widoczne logo, napisy, oznaczenia)`;
      textContent += `\n- Określ typ i kategorię urządzenia/elementu`;
      textContent += `\n- Sprawdź czy widoczne są numery seryjne, kody produktów, oznaczenia techniczne`;
      textContent += `\n- Zidentyfikuj konkretne części składowe (np. zawór, głowica, gniazdko, przewód)`;
      
      textContent += `\n\n2. OCENA STANU TECHNICZNEGO:`;
      textContent += `\n- Oszacuj stan zużycia (nowy, dobry, średni, zły, bardzo zły)`;
      textContent += `\n- Zidentyfikuj widoczne uszkodzenia (pęknięcia, korozja, przebarwienia, wycieki, iskrzenie)`;
      textContent += `\n- Sprawdź czy widoczne są oznaki nieprawidłowego użytkowania lub montażu`;
      textContent += `\n- Oszacuj wiek urządzenia/elementu na podstawie stanu wizualnego`;
      
      textContent += `\n\n3. DIAGNOSTYKA PROBLEMU:`;
      textContent += `\n- Zidentyfikuj dokładnie co jest nie tak (konkretny problem, nie ogólny opis)`;
      textContent += `\n- Określ prawdopodobne przyczyny problemu na podstawie tego co widzisz`;
      textContent += `\n- Oszacuj poziom zagrożenia (low/medium/high) - szczególnie ważne dla elektryki i hydrauliki`;
      textContent += `\n- Sprawdź czy problem wymaga natychmiastowej interwencji`;
      
      textContent += `\n\n4. REKOMENDACJE:`;
      textContent += `\n- Zaproponuj konkretne rozwiązanie z uwzględnieniem zidentyfikowanej marki/modelu`;
      textContent += `\n- Wymień konkretne części zamienne (nazwy, typy, rozmiary) jeśli są potrzebne`;
      textContent += `\n- Oszacuj koszt naprawy w PLN (uwzględnij markę/model, stan zużycia, lokalne ceny i podane widełki cenowe)`;
      textContent += `\n- Zaproponuj czas realizacji naprawy`;
      
      // Dodaj specjalistyczne instrukcje w zależności od kategorii
      if (category === 'elektryka') {
        textContent += `\n\n⚠️ SPECJALNE UWAGI DLA ELEKTRYKI:`;
        textContent += `\n- Zwróć szczególną uwagę na bezpieczeństwo elektryczne - sprawdź czy widoczne są oznaki zwarcia, przegrzania, iskrzenia`;
        textContent += `\n- Zidentyfikuj typ instalacji (jednofazowa, trójfazowa, niskie/napięcie)`;
        textContent += `\n- Sprawdź czy widoczne są oznaczenia napięcia, mocy, bezpieczników`;
        textContent += `\n- Ostrzeż przed niebezpiecznymi działaniami - NIGDY nie dotykać instalacji pod napięciem`;
      } else if (category === 'hydraulika') {
        textContent += `\n\n⚠️ SPECJALNE UWAGI DLA HYDRAULIKI:`;
        textContent += `\n- Zwróć uwagę na stan instalacji, ciśnienie wody, widoczne wycieki, korozję`;
        textContent += `\n- Zidentyfikuj typ instalacji (miedziana, z tworzywa, stalowa)`;
        textContent += `\n- Sprawdź czy widoczne są zawory, filtry, reduktory ciśnienia`;
        textContent += `\n- Oszacuj skalę problemu (mały wyciek, duży wyciek, całkowite zatkanie)`;
      } else if (category === 'it') {
        textContent += `\n\n⚠️ SPECJALNE UWAGI DLA IT:`;
        textContent += `\n- Zidentyfikuj markę i model urządzenia (jeśli widoczne na obudowie, ekranie, naklejkach)`;
        textContent += `\n- Sprawdź czy widoczne są błędy na ekranie (kody błędów, komunikaty systemowe)`;
        textContent += `\n- Określ system operacyjny jeśli widoczny (Windows, macOS, Linux, Android, iOS)`;
        textContent += `\n- Zidentyfikuj typ problemu (sprzętowy, programowy, połączenie sieciowe)`;
      } else if (category === 'remont') {
        textContent += `\n\n⚠️ SPECJALNE UWAGI DLA REMONTU:`;
        textContent += `\n- Oszacuj powierzchnię do remontu (jeśli widoczne na zdjęciu)`;
        textContent += `\n- Zidentyfikuj typ powierzchni (ściana, podłoga, sufit, drzwi, okno)`;
        textContent += `\n- Określ stan podłoża (gładki, nierówny, uszkodzony, wilgotny)`;
        textContent += `\n- Sprawdź czy widoczne są materiały (farby, tapety, płytki, kleje)`;
      }
      
      textContent += `\n\nWAŻNE: Bądź bardzo precyzyjny w identyfikacji - marka, model i konkretne części są kluczowe dla dokładnego oszacowania kosztów i czasu naprawy.`;
    }
    
    // Dodaj dostępne części zamienne z katalogu (tylko w pierwszej wiadomości)
    if (availableParts && availableParts.length > 0 && isFirstMessage) {
      textContent += `\n\nDOSTĘPNE CZĘŚCI ZAMIENNE W KATALOGU (dla kategorii ${category || 'ogólnej'}):`;
      availableParts.slice(0, 10).forEach((part, idx) => {
        textContent += `\n\n${idx + 1}. ${part.name}`;
        textContent += `\n   Typ: ${part.type}`;
        if (part.specification) {
          textContent += `\n   Specyfikacja: ${part.specification}`;
        }
        if (part.typicalPrice) {
          textContent += `\n   Cena: ${part.typicalPrice.min}-${part.typicalPrice.max} ${part.typicalPrice.currency || 'PLN'}`;
        }
        if (part.availability) {
          const availabilityText = {
            'very_high': 'Bardzo wysoka',
            'high': 'Wysoka',
            'medium': 'Średnia',
            'low': 'Niska'
          };
          textContent += `\n   Dostępność: ${availabilityText[part.availability] || part.availability}`;
        }
        if (part.commonBrands && part.commonBrands.length > 0) {
          textContent += `\n   Popularne marki: ${part.commonBrands.join(', ')}`;
        }
      });
      textContent += `\n\nUżyj tych informacji jako referencji przy proponowaniu części zamiennych i szacowaniu kosztów.`;
    }

    const content = [
      {
        type: 'text',
        text: textContent
      }
    ];

    // Dodaj obrazy jeśli są dostępne
    if (imageUrls && imageUrls.length > 0) {
      for (const imageUrl of imageUrls) {
        content.push({
          type: 'image_url',
          image_url: {
            url: imageUrl
          }
        });
      }
    }

    return {
      role: 'user',
      content: content
    };
  }

  parseClaudeResponse(text) {
    try {
      // Spróbuj wyciągnąć JSON z odpowiedzi
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        
        // Waliduj i uzupełnij strukturę
        return {
          serviceCandidate: parsed.serviceCandidate || {
            code: 'inne',
            name: 'Inne usługi',
            confidence: 0.5
          },
          deviceIdentification: parsed.deviceIdentification || {
            brand: null,
            model: null,
            type: null,
            serialNumber: null,
            parts: []
          },
          conditionAssessment: parsed.conditionAssessment || {
            overallCondition: 'unknown',
            visibleDamage: [],
            wearLevel: 'unknown',
            estimatedAge: 'unknown'
          },
          diySteps: parsed.diySteps || [],
          requiredParts: parsed.requiredParts || [],
          dangerFlags: parsed.dangerFlags || [],
          urgency: parsed.urgency || 'normal',
          estimatedCost: parsed.estimatedCost || {
            min: null,
            max: null,
            currency: 'PLN',
            breakdown: null
          },
          estimatedTime: parsed.estimatedTime || '1-3 dni',
          providerType: parsed.providerType || 'both',
          rawResponse: text
        };
      } else {
        // Fallback jeśli nie ma JSON
        return this.createFallbackResponse(text);
      }
    } catch (error) {
      console.error('Error parsing Claude response:', error);
      return this.createFallbackResponse(text);
    }
  }

  createFallbackResponse(text) {
    return {
      serviceCandidate: {
        code: 'inne',
        name: 'Inne usługi',
        confidence: 0.3
      },
      deviceIdentification: {
        brand: null,
        model: null,
        type: null,
        serialNumber: null,
        parts: []
      },
      conditionAssessment: {
        overallCondition: 'unknown',
        visibleDamage: [],
        wearLevel: 'unknown',
        estimatedAge: 'unknown'
      },
      diySteps: [
        {
          title: 'Kontakt z wykonawcą',
          description: 'Skontaktuj się z wykwalifikowanym wykonawcą w Twojej okolicy.',
          safety: 'safe'
        }
      ],
      requiredParts: [],
      dangerFlags: [],
      urgency: 'normal',
      estimatedCost: {
        min: null,
        max: null,
        currency: 'PLN',
        breakdown: null
      },
      estimatedTime: '1-3 dni',
      providerType: 'both',
      rawResponse: text
    };
  }

  // Wyciągnij nazwę usługi z opisu problemu
  extractServiceFromDescription(description) {
    const serviceKeywords = [
      'hydraulik', 'elektryk', 'remont', 'malowanie', 'ogrodnictwo',
      'sprzątanie', 'klimatyzacja', 'ogrzewanie', 'dach', 'okna',
      'drzwi', 'podłoga', 'łazienka', 'kuchnia', 'IT', 'komputer'
    ];
    
    const lowerDesc = description.toLowerCase();
    for (const keyword of serviceKeywords) {
      if (lowerDesc.includes(keyword)) {
        return keyword;
      }
    }
    
    return 'usługi remontowe';
  }

  // Sformatuj wyniki wyszukiwania internetowego
  formatWebSearchResults(webResults) {
    let context = '';
    
    for (const result of webResults) {
      if (result.results && result.results.length > 0) {
        context += `\n${result.query}:\n`;
        for (const item of result.results.slice(0, 2)) {
          context += `- ${item.title}: ${item.snippet}\n`;
        }
      }
    }
    
    return context;
  }

  // Metoda do testowania połączenia
  async testConnection() {
    if (!this.isEnabled) {
      return { success: false, error: 'Claude API is not enabled' };
    }

    try {
      const response = await this.client.messages.create({
        model: process.env.CLAUDE_DEFAULT || 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'Test connection - respond with "OK"'
          }
        ]
      });

      return { 
        success: true, 
        message: 'Claude API connection successful',
        response: response.content[0].text
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }
}

// Eksportuj singleton
const claudeService = new ClaudeService();
module.exports = claudeService;
