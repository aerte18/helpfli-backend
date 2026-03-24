/**
 * Streaming endpoint dla AI Concierge
 * Server-Sent Events (SSE) dla real-time odpowiedzi
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { validateConciergeRequest } = require('../ai/schemas/conciergeSchemas');
const { streamLLM } = require('../ai/utils/llmAdapter');
const { buildConciergePrompt } = require('../ai/agents/conciergeAgent');
const ConversationMemoryService = require('../services/ConversationMemoryService');
const AIAnalyticsService = require('../services/AIAnalyticsService');

/**
 * GET /api/ai/concierge/v2/stream
 * Streaming endpoint dla AI Concierge (SSE)
 */
router.get('/v2/stream', authMiddleware, async (req, res) => {
  const startTime = Date.now();
  let requestId = null;
  
  try {
    // Ustaw headers dla SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // Helper do wysyłania eventów
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    
    // Parsuj request (z query params lub body)
    const message = req.query.message || req.body.message || '';
    const sessionId = req.query.sessionId || req.headers['x-session-id'] || `session_${Date.now()}_${req.user?.id}`;
    
    if (!message) {
      send('error', { message: 'Brak wiadomości' });
      return res.end();
    }
    
    const userId = req.user?.id || req.user?._id;
    requestId = AIAnalyticsService.generateRequestId();
    
    // Pobierz kontekst z pamięci
    const memoryContext = await ConversationMemoryService.getContext(userId, sessionId, 10, 'concierge');
    
    // Przygotuj messages
    const messages = [];
    
    // Dodaj summary jeśli istnieje
    if (memoryContext.summary) {
      messages.push({
        role: 'system',
        content: `Kontekst z poprzednich rozmów: ${memoryContext.summary}`
      });
    }
    
    // Dodaj ostatnie wiadomości z pamięci
    const memoryMessages = memoryContext.recentMessages.map(m => ({
      role: m.role,
      content: m.content
    }));
    
    messages.push(...memoryMessages, { role: 'user', content: message });
    
    // Ograniczenie do ostatnich 20 wiadomości
    const finalMessages = messages.slice(-20);
    
    // Pobierz usługi dla promptu
    let services = [];
    try {
      const Service = require('../models/Service');
      const allServices = await Service.find({}).select('code name').lean();
      services = allServices.map(s => s.code || s.name).filter(Boolean);
    } catch (err) {
      services = ['hydraulik_naprawa', 'elektryk_naprawa', 'zlota_raczka', 'sprzatanie', 'remont', 'inne'];
    }
    
    // Zbuduj prompt
    const systemPrompt = buildConciergePrompt({
      allowedServices: services,
      userLocation: memoryContext.preferences?.preferredLocations?.[0] || null
    });
    
    // Stream odpowiedź
    let fullText = '';
    
    try {
      await streamLLM(systemPrompt, finalMessages, (chunk) => {
        fullText += chunk;
        send('token', { chunk });
      });
      
      // Zapisz do pamięci (async)
      ConversationMemoryService.addMessage(userId, sessionId, 'user', message, 'concierge', {}, 'concierge')
        .catch(err => console.error('Error saving user message:', err));
      
      ConversationMemoryService.addMessage(userId, sessionId, 'assistant', fullText, 'concierge', {}, 'concierge')
        .catch(err => console.error('Error saving assistant message:', err));
      
      // Track analytics
      const responseTime = Date.now() - startTime;
      AIAnalyticsService.trackRequest({
        requestId,
        userId,
        sessionId,
        agent: 'concierge',
        endpoint: '/api/ai/concierge/v2/stream',
        messageCount: finalMessages.length,
        responseTime,
        success: true,
        llmProvider: 'claude',
        metadata: { streaming: true }
      }).catch(err => console.error('Error tracking analytics:', err));
      
      // Wyślij event zakończenia
      send('done', {
        messageId: `msg_${Date.now()}`,
        sessionId,
        requestId,
        fullText
      });
      
    } catch (streamError) {
      console.error('Streaming error:', streamError);
      send('error', { message: 'Błąd podczas streamowania odpowiedzi' });
      
      // Track error
      const responseTime = Date.now() - startTime;
      AIAnalyticsService.trackRequest({
        requestId,
        userId,
        sessionId,
        agent: 'concierge',
        endpoint: '/api/ai/concierge/v2/stream',
        responseTime,
        success: false,
        error: streamError.message,
        errorType: 'llm_error',
        metadata: { streaming: true }
      }).catch(err => console.error('Error tracking error analytics:', err));
    }
    
    res.end();
    
  } catch (error) {
    console.error('Stream endpoint error:', error);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: 'Błąd serwera' })}\n\n`);
    }
    res.end();
  }
});

module.exports = router;

