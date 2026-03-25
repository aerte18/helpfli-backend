const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');

// POST /api/provider-ai-chat - chat AI dla providerów
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { message, orderId } = req.body;
    
    if (!message) {
      return res.status(400).json({ message: 'Brak wiadomości' });
    }
    
    const provider = await User.findById(req.user._id);
    
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    
    // Sprawdź pakiet użytkownika
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    const packageType = subscription?.planKey || 'PROV_FREE';
    const isFree = packageType === 'PROV_FREE';
    const isStandard = packageType === 'PROV_STD';
    const isPro = packageType === 'PROV_PRO';
    
    // Dla pakietu FREE - sprawdź limit zapytań (20 zapytań miesięcznie)
    if (isFree) {
      const currentMonth = new Date();
      currentMonth.setDate(1);
      currentMonth.setHours(0, 0, 0, 0);
      
      const UsageAnalytics = require('../models/UsageAnalytics');
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      
      // Pobierz statystyki użycia
      let usage = await UsageAnalytics.findOne({ 
        user: req.user._id, 
        monthKey 
      });
      
      if (!usage) {
        usage = await UsageAnalytics.create({
          user: req.user._id,
          monthKey,
          planKey: 'PROV_FREE',
          providerAiChatQueries: 0,
          providerAiChatQueriesLimit: 20 // Limit 20 zapytań dla FREE
        });
      }
      
      // Sprawdź limit (20 zapytań dla FREE)
      const FREE_LIMIT = 20;
      if (usage.providerAiChatQueries >= FREE_LIMIT) {
        // Utwórz powiadomienie zamiast zwracania błędu
        const Notification = require('../models/Notification');
        
        // Sprawdź czy już nie ma powiadomienia o przekroczeniu limitu (aby nie spamować)
        const existingNotification = await Notification.findOne({
          user: req.user._id,
          type: 'limit_exceeded',
          read: false,
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Ostatnie 24h
        });
        
        if (!existingNotification) {
          await Notification.create({
            user: req.user._id,
            type: 'limit_exceeded',
            title: 'Przekroczono limit AI Chat',
            message: `Wykorzystałeś wszystkie zapytania do AI Chat w tym miesiącu (${FREE_LIMIT}). Ulepsz pakiet Standard lub PRO aby uzyskać nielimitowany dostęp.`,
            link: '/account/subscriptions',
            metadata: {
              limit: FREE_LIMIT,
              used: usage.providerAiChatQueries,
              planKey: packageType,
              upsell: {
                recommendedPlanKey: 'PROV_STD',
                title: 'STANDARD – nielimitowany AI Chat',
                description: 'Uzyskaj nielimitowany dostęp do AI Chat i więcej odpowiedzi na zlecenia.',
              }
            }
          });
        }
        
        return res.status(403).json({ 
          message: `Przekroczono limit ${FREE_LIMIT} zapytań do AI Chat miesięcznie. Sprawdź powiadomienia aby zobaczyć szczegóły.`
        });
      }
      
      // Zwiększ licznik użycia
      usage.providerAiChatQueries = (usage.providerAiChatQueries || 0) + 1;
      await usage.save();
    }
    
    // Pobierz szczegóły zlecenia jeśli podano orderId
    let orderDetails = null;
    if (orderId) {
      const Order = require('../models/Order');
      orderDetails = await Order.findById(orderId).lean();
    }
    
    // Użyj nowego Provider AI Handler z agentami
    let aiResponse = null;
    let agentPayload = null;
    
    try {
      const { runProviderOrchestrator } = require('../ai/agents/providerOrchestrator');
      const { runOfferAgent } = require('../ai/agents/offerAgent');
      const { runPricingProviderAgent } = require('../ai/agents/pricingProviderAgent');
      
      // Przygotuj conversationHistory
      const conversationHistory = req.body.conversationHistory || [];
      const messages = conversationHistory.length > 0
        ? conversationHistory.map(m => ({ role: m.role, content: m.text || m.content || m.message }))
        : [{ role: 'user', content: message }];
      
      if (conversationHistory.length === 0) {
        messages.push({ role: 'user', content: message });
      }
      
      // Przygotuj kontekst
      const orderContext = orderDetails ? {
        service: typeof orderDetails.service === 'object' ? orderDetails.service?.code : orderDetails.service,
        description: orderDetails.description,
        urgency: orderDetails.urgency,
        location: orderDetails.location?.city || orderDetails.location || null,
        budget: orderDetails.budget ? { min: orderDetails.budget * 0.8, max: orderDetails.budget * 1.2 } : null
      } : {};
      
      const providerInfo = {
        name: provider.name,
        level: provider.providerLevel || provider.providerTier || 'standard',
        rating: provider.rating || 0,
        services: provider.services || [],
        location: provider.location
      };
      
      // Wywołaj orchestrator
      const orchestratorResult = await runProviderOrchestrator({
        messages,
        orderContext,
        providerInfo
      });
      
      // Główna odpowiedź = naturalna wypowiedź (jak u klienta). Szczegóły w agents.
      aiResponse = orchestratorResult.reply || 'Jak mogę Ci pomóc?';
      
      // Wyszukiwanie najlepszych zleceń dla providera (bez kontekstu konkretnego zlecenia)
      if (orchestratorResult.nextStep === 'search_orders') {
        try {
          const toolRegistry = require('../ai/utils/toolRegistry');
          const sortBy = (message || '').toLowerCase().match(/gdzie zarobić|potencjał zarobku|najwięcej zarobić|najwyższy budżet/) ? 'earning_potential' : 'best_match';
          const toolResult = await toolRegistry.execute('searchOrdersForProvider', { sortBy, limit: 15 }, {
            userId: req.user._id,
            agentType: 'provider_orchestrator'
          });
          if (toolResult.success && toolResult.result?.orders?.length) {
            const { orders, summary, sortBy: resultSortBy } = toolResult.result;
            agentPayload = { searchOrders: { orders, sortBy: resultSortBy, summary } };
            const lines = orders.slice(0, 10).map((o) => {
              const budget = o.budgetMax != null ? ` do ${o.budgetMax} zł` : (o.budgetMin != null ? ` od ${o.budgetMin} zł` : '');
              return `• ${o.service || 'Usługa'}${o.city ? ` (${o.city})` : ''}${budget} – ${o.link}`;
            });
            aiResponse = `${aiResponse}\n\n${summary}\n\n${lines.join('\n')}`;
          } else if (toolResult.success && toolResult.result?.orders?.length === 0) {
            aiResponse = `${aiResponse}\n\nAktualnie nie ma otwartych zleceń dopasowanych do Twoich usług. Sprawdź ponownie później lub poszerz kategorie usług w profilu.`;
          }
        } catch (err) {
          console.error('searchOrdersForProvider failed:', err);
          aiResponse = `${aiResponse}\n\nNie udało się wczytać listy zleceń. Spróbuj w zakładce „Zlecenia” w panelu.`;
        }
      }
      
      // Routing do agentów (wyniki w payloadzie, nie wklejane do tekstu)
      if (orchestratorResult.nextStep === 'suggest_offer' && orderDetails) {
        try {
          const Offer = require('../models/Offer');
          const existingOffers = await Offer.find({
            orderId: orderDetails._id,
            providerId: provider._id
          }).lean();
          
          agentPayload = {
            offer: await runOfferAgent({
              orderContext,
              providerInfo,
              existingOffers,
              conversationHistory: messages
            })
          };
        } catch (error) {
          console.error('Offer agent failed:', error);
        }
      } else if (orchestratorResult.nextStep === 'suggest_pricing') {
        try {
          agentPayload = {
            pricing: await runPricingProviderAgent({
              orderContext,
              providerInfo,
              marketData: null
            })
          };
          // Jedno zdanie "Dlaczego ta cena" w głównej odpowiedzi (nie tylko w karcie)
          if (agentPayload?.pricing?.rationale?.length) {
            const reason = agentPayload.pricing.rationale[0];
            if (reason && !aiResponse.includes(reason)) {
              aiResponse = (aiResponse.trim() + ' ' + reason).trim();
            }
          }
        } catch (error) {
          console.error('Pricing provider agent failed:', error);
        }
      }
    } catch (error) {
      console.error('Provider AI agents error, using fallback:', error);
      // Fallback do starej metody
      aiResponse = await generateProviderAiResponse(message, provider, orderDetails, packageType);
    }
    
    // Pobierz aktualne statystyki użycia dla odpowiedzi
    const UsageAnalytics = require('../models/UsageAnalytics');
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const usage = await UsageAnalytics.findOne({ 
      user: req.user._id, 
      monthKey 
    });
    
    res.json({
      response: aiResponse,
      agents: agentPayload || {},
      package: packageType,
      usage: {
        used: usage?.providerAiChatQueries || 0,
        limit: isFree ? 20 : (isStandard || isPro ? Infinity : 20),
        remaining: isFree ? Math.max(0, 20 - (usage?.providerAiChatQueries || 0)) : Infinity
      },
      orderDetails: orderDetails ? {
        id: orderDetails._id,
        service: orderDetails.service,
        description: orderDetails.description,
        location: orderDetails.location
      } : null,
      // Dodaj wyniki agentów (jeśli dostępne)
      agents: agentPayload || {}
    });
  } catch (error) {
    console.error('❌ Błąd AI chat:', error);
    res.status(500).json({ message: 'Błąd generowania odpowiedzi AI' });
  }
});

// Funkcja generująca odpowiedź AI dla providerów
async function generateProviderAiResponse(message, provider, orderDetails, packageType) {
  const isPro = packageType === 'PROV_PRO';
  
  // Podstawowe informacje o providerze
  const providerInfo = {
    name: provider.name,
    services: provider.services || [],
    location: provider.location,
    level: provider.providerLevel || 'basic',
    tier: provider.providerTier || 'basic'
  };
  
  // Kontekst zlecenia
  const orderContext = orderDetails ? `
Zlecenie: ${orderDetails.service || 'Usługa'}
Opis: ${orderDetails.description || 'Brak opisu'}
Lokalizacja: ${orderDetails.location?.city || 'Nieznana'}
` : '';
  
  // Prompt dla AI
  const prompt = `
Jesteś AI asystentem dla platformy Helpfli, pomagającym providerom (wykonawcom) w tworzeniu lepszych ofert i komunikacji z klientami.

Informacje o providerze:
- Imię: ${providerInfo.name}
- Usługi: ${providerInfo.services.join(', ') || 'Nie określono'}
- Lokalizacja: ${providerInfo.location || 'Nie określono'}
- Poziom: ${providerInfo.level}
- Tier: ${providerInfo.tier}

${orderContext}

Wiadomość od providera: "${message}"

Odpowiedz jako pomocny AI asystent, który:
1. Pomaga w tworzeniu profesjonalnych ofert
2. Sugeruje odpowiednie ceny na podstawie rynku
3. Podpowiada jak lepiej komunikować się z klientami
4. Daje wskazówki dotyczące terminów realizacji
5. Pomaga w rozwiązywaniu problemów z klientami

${isPro ? 'Jako pakiet PRO, możesz też udzielać bardziej zaawansowanych porad biznesowych i analitycznych.' : ''}

Odpowiedz krótko i konkretnie, maksymalnie 200 słów.
`;

  try {
    // Symulacja odpowiedzi AI (w rzeczywistej implementacji użyj OpenAI API)
    const responses = [
      `Cześć ${providerInfo.name}! Widzę, że potrzebujesz pomocy z ofertą. Oto kilka wskazówek:

1. **Cena**: Sprawdź lokalne ceny rynkowe dla "${orderDetails?.service || 'tej usługi'}"
2. **Termin**: Zaproponuj realistyczny termin realizacji
3. **Komunikacja**: Bądź profesjonalny i odpowiadaj szybko
4. **Szczegóły**: Zapytaj o dodatkowe informacje jeśli potrzebujesz

Czy chcesz, żebym pomógł Ci sformułować konkretną ofertę?`,

      `Świetnie, że chcesz poprawić swoją ofertę! Oto moje sugestie:

**Dla lepszej oferty:**
- Opisz dokładnie co zrobisz
- Podaj jasny termin realizacji
- Zaproponuj konkurencyjną cenę
- Dodaj gwarancję jakości

**Komunikacja z klientem:**
- Odpowiadaj w ciągu 2 godzin
- Bądź uprzejmy i profesjonalny
- Zadawaj pytania jeśli coś nie jest jasne

Potrzebujesz pomocy z konkretnym aspektem oferty?`,

      `Rozumiem Twoje pytanie! Jako doświadczony provider, oto co radzę:

**Strategia cenowa:**
- Sprawdź konkurencję w okolicy
- Uwzględnij koszty materiałów i czasu
- Zaproponuj kilka opcji cenowych

**Dodatkowe usługi:**
- Możesz zaproponować dodatkowe usługi
- Pokaż swoją ekspertyzę
- Zaoferuj gwarancję

Czy chcesz, żebym pomógł Ci z konkretnym zleceniem?`
    ];
    
    // Wybierz losową odpowiedź (w rzeczywistości użyj OpenAI)
    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    
    return randomResponse;
  } catch (error) {
    console.error('❌ Błąd generowania odpowiedzi AI:', error);
    return 'Przepraszam, wystąpił błąd podczas generowania odpowiedzi. Spróbuj ponownie.';
  }
}

module.exports = router;



