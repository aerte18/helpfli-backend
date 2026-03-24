/**
 * Provider AI Agents Handler
 * Centralny punkt wejścia dla provider AI agents
 */

const { runProviderOrchestrator } = require('../agents/providerOrchestrator');
const { runOfferAgent } = require('../agents/offerAgent');
const { runPricingProviderAgent } = require('../agents/pricingProviderAgent');
const ConversationMemoryService = require('../../services/ConversationMemoryService');

/**
 * Handler dla provider AI chat
 * Orchestrator który routuje do odpowiednich agentów
 */
async function providerAiHandler(req, res) {
  const startTime = Date.now();
  let requestId = null;
  
  try {
    const { validateProviderRequest } = require('../schemas/conciergeSchemas');
    const AIAnalyticsService = require('../../services/AIAnalyticsService');
    
    requestId = AIAnalyticsService.generateRequestId();
    
    // Parsuj request
    const { message, orderId, conversationHistory = [] } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        ok: false,
        message: 'Brak wiadomości' 
      });
    }
    
    // Pobierz provider info
    const provider = req.user;
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ 
        ok: false,
        message: 'Dostęp tylko dla providerów' 
      });
    }
    
    // Pobierz szczegóły zlecenia jeśli podano orderId
    let orderContext = null;
    if (orderId) {
      try {
        const Order = require('../../models/Order');
        const order = await Order.findById(orderId)
          .populate('service')
          .lean();
        
        if (order) {
          orderContext = {
            service: typeof order.service === 'object' ? order.service?.code || order.service?.name : order.service,
            description: order.description,
            urgency: order.urgency,
            location: order.location?.city || order.location || null,
            budget: order.budget ? {
              min: order.budget * 0.8,
              max: order.budget * 1.2
            } : null
          };
        }
      } catch (error) {
        console.warn('Could not load order context:', error.message);
      }
    }
    
    // Przygotuj provider info
    const providerInfo = {
      name: provider.name,
      level: provider.providerLevel || provider.providerTier || 'standard',
      rating: provider.rating || 0,
      services: provider.services || [],
      location: provider.location
    };
    
    // Pobierz lub utwórz sessionId
    const userId = provider._id || provider.id;
    const sessionId = req.body.sessionId || req.headers['x-session-id'] || `provider_session_${Date.now()}_${userId}`;
    
    // Pobierz kontekst z pamięci
    const memoryContext = await ConversationMemoryService.getContext(userId, sessionId, 10, 'provider_assistant');
    
    // Przygotuj messages z pamięcią
    const existingMessages = conversationHistory.length > 0 
      ? conversationHistory.map(m => ({ role: m.role, content: m.text || m.content || m.message }))
      : [];
    
    // Dodaj aktualną wiadomość
    existingMessages.push({ role: 'user', content: message });
    
    // Dodaj summary jeśli istnieje
    let allMessages = [];
    if (memoryContext.summary && memoryContext.summaryMessageCount > 0) {
      allMessages.push({
        role: 'system',
        content: `Kontekst z poprzednich rozmów (${memoryContext.summaryMessageCount} wiadomości): ${memoryContext.summary}`
      });
    }
    
    // Dodaj ostatnie wiadomości z pamięci + nowe
    const memoryMessages = memoryContext.recentMessages.map(m => ({
      role: m.role,
      content: m.content
    }));
    
    allMessages = [...allMessages, ...memoryMessages, ...existingMessages];
    
    // Ograniczenie do ostatnich 20 wiadomości
    const messages = allMessages.slice(-20);
    
    // Wywołaj Provider Orchestrator
    const orchestratorResult = await runProviderOrchestrator({
      messages,
      orderContext: orderContext || {},
      providerInfo: {
        ...providerInfo,
        preferences: memoryContext.preferences // Dodaj preferencje z pamięci
      }
    });
    
    // Routing do innych agentów na podstawie nextStep
    const agentPayload = {};
    
    // Offer Agent - pomoc w tworzeniu oferty
    if (orchestratorResult.nextStep === 'suggest_offer') {
      try {
        // Pobierz istniejące oferty
        let existingOffers = [];
        if (orderId) {
          try {
            const Offer = require('../../models/Offer');
            existingOffers = await Offer.find({
              orderId,
              providerId: provider._id || provider.id
            }).lean();
          } catch (error) {
            console.warn('Could not load existing offers:', error.message);
          }
        }
        
        agentPayload.offer = await runOfferAgent({
          orderContext: orderContext || {},
          providerInfo,
          existingOffers,
          conversationHistory: messages
        });
      } catch (error) {
        console.error('Offer agent failed:', error.message);
      }
    }
    
    // Pricing Provider Agent - pomoc z ceną
    if (orchestratorResult.nextStep === 'suggest_pricing') {
      try {
        agentPayload.pricing = await runPricingProviderAgent({
          orderContext: orderContext || {},
          providerInfo,
          marketData: null
        });
      } catch (error) {
        console.error('Pricing provider agent failed:', error.message);
      }
    }
    
    // TODO: Communication Agent (można dodać później)
    
    // Zapisz wiadomości do pamięci (async)
    ConversationMemoryService.addMessage(
      userId,
      sessionId,
      'user',
      message,
      'provider_orchestrator',
      { orderId },
      'provider_assistant'
    ).catch(err => console.error('Error saving provider user message:', err));
    
    const replyText = orchestratorResult.reply + (agentPayload.offer ? `\n\n💰 Sugerowana cena: ${agentPayload.offer.suggestedPrice?.recommended || '200'} PLN` : '');
    
    ConversationMemoryService.addMessage(
      userId,
      sessionId,
      'assistant',
      replyText,
      orchestratorResult.nextStep || 'provider_orchestrator',
      {
        intent: orchestratorResult.intent,
        nextStep: orchestratorResult.nextStep,
        agents: Object.keys(agentPayload)
      },
      'provider_assistant'
    ).catch(err => console.error('Error saving provider assistant message:', err));
    
    // Aktualizuj ostatnią interakcję
    ConversationMemoryService.updateLastInteraction(userId, sessionId, {
      intent: orchestratorResult.intent,
      nextStep: orchestratorResult.nextStep,
      orderId: orderId || null
    }, 'provider_assistant').catch(err => console.error('Error updating provider last interaction:', err));
    
    // Generuj messageId dla feedbacku
    const messageId = `provider_msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    // Oblicz response time
    const responseTime = Date.now() - startTime;
    
    // Track analytics (async)
    const agentChain = ['provider_orchestrator', ...Object.keys(agentPayload)];
    AIAnalyticsService.trackRequest({
      requestId,
      userId,
      sessionId,
      agent: 'provider_orchestrator',
      agentChain,
      endpoint: '/api/provider-ai-chat',
      messageCount: messages.length,
      responseTime,
      success: true,
      llmProvider: 'claude',
      quality: {
        confidence: orchestratorResult.confidence || 0.8
      },
      metadata: {
        intent: orchestratorResult.intent,
        nextStep: orchestratorResult.nextStep,
        agentsCalled: agentChain,
        orderId: orderId || null
      }
    }).catch(err => console.error('Error tracking provider analytics:', err));
    
    return res.json({
      ok: true,
      agent: 'provider_orchestrator',
      result: orchestratorResult,
      agents: agentPayload,
      // Backward compatibility
      response: replyText,
      reply: orchestratorResult.reply,
      // Nowe pola dla Memory i Feedback
      sessionId: sessionId,
      messageId: messageId,
      requestId: requestId,
      memory: {
        hasHistory: memoryContext.recentMessages.length > 0,
        hasSummary: !!memoryContext.summary,
        preferences: memoryContext.preferences
      }
    });
    
  } catch (error) {
    console.error('Provider AI Handler error:', error);
    
    // Track error analytics
    const responseTime = Date.now() - startTime;
    const AIAnalyticsService = require('../../services/AIAnalyticsService');
    AIAnalyticsService.trackRequest({
      requestId: requestId || AIAnalyticsService.generateRequestId(),
      userId: req.user?._id || req.user?.id || null,
      sessionId: req.body.sessionId || 'unknown',
      agent: 'provider_orchestrator',
      endpoint: '/api/provider-ai-chat',
      responseTime,
      success: false,
      error: error.message?.substring(0, 500),
      errorType: 'other',
      metadata: {}
    }).catch(err => console.error('Error tracking provider error analytics:', err));
    
    return res.status(500).json({
      ok: false,
      error: 'PROVIDER_AI_FAILED',
      message: 'Błąd podczas przetwarzania żądania AI. Spróbuj ponownie.',
      result: {
        reply: 'Przepraszam, wystąpił błąd. Spróbuj ponownie.',
        nextStep: 'general_help'
      }
    });
  }
}

module.exports = {
  providerAiHandler
};

