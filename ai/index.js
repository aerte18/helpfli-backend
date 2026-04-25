/**
 * Główny export dla AI Agentów
 * Centralny punkt wejścia dla wszystkich agentów
 */

const { runConciergeAgent } = require('./agents/conciergeAgent');
const { runDiagnosticAgent } = require('./agents/diagnosticAgent');
const { runPricingAgent } = require('./agents/pricingAgent');
const { runDIYAgent } = require('./agents/diyAgent');
const { runMatchingAgent } = require('./agents/matchingAgent');
const { runOrderDraftAgent } = require('./agents/orderDraftAgent');
const {
  getDraft,
  saveDraft,
  mergeDraftContext,
  attachStoredContext
} = require('./utils/draftSessionStore');

/**
 * Handler dla endpointu /api/ai/concierge/v2
 * Orchestrator który routuje do odpowiednich agentów
 */
async function conciergeHandler(req, res) {
  const startTime = Date.now();
  let requestId = null;
  
  try {
    const { validateConciergeRequest } = require('./schemas/conciergeSchemas');
    const ConversationMemoryService = require('../services/ConversationMemoryService');
    const AIAnalyticsService = require('../services/AIAnalyticsService');
    const PersonalizationService = require('../services/PersonalizationService');
    const WebSearchIntegrationService = require('../services/WebSearchIntegrationService');
    const multiModalService = require('../services/MultiModalService');
    const abTestingService = require('../services/ABTestingService');
    
    requestId = AIAnalyticsService.generateRequestId();
    
    // Parsuj i waliduj request
    const parsed = validateConciergeRequest(req.body);

    // Pobierz kontekst użytkownika
    const userId = req.user?.id || req.user?._id;
    
    // A/B Testing (Faza 3) - przypisz warianty eksperymentów
    const abVariants = {
      responseLength: abTestingService.assignVariant(userId, 'response_length'),
      communicationStyle: abTestingService.assignVariant(userId, 'communication_style'),
      toolCalling: abTestingService.assignVariant(userId, 'tool_calling')
    };

    const userContext = {
      ...parsed.userContext,
      userId
    };
    
    // Pobierz lub utwórz sessionId (z requestu lub generuj nowy)
    const sessionId = parsed.sessionId || req.headers['x-session-id'] || `session_${Date.now()}_${userId}`;
    
    // Pobierz kontekst z pamięci (ostatnie wiadomości + preferencje)
    const memoryContext = await ConversationMemoryService.getContext(userId, sessionId, 10, 'concierge');
    
    // Złącz historię z requestu z historią z pamięci
    const existingMessages = parsed.messages || [];
    
    // Przygotuj finalne wiadomości z kontekstem
    let allMessages = [];
    
    // 1. Dodaj summary jako system message (jeśli istnieje)
    if (memoryContext.summary && memoryContext.summaryMessageCount > 0) {
      allMessages.push({
        role: 'system',
        content: `Kontekst z poprzednich rozmów (${memoryContext.summaryMessageCount} wiadomości): ${memoryContext.summary}`
      });
    }
    
    // 2. Dodaj ostatnie wiadomości z pamięci (które nie są jeszcze w existingMessages)
    const memoryMessages = memoryContext.recentMessages
      .filter(m => m.role !== 'system') // Wyklucz system messages
      .map(m => ({
        role: m.role,
        content: m.content
      }));
    
    // 3. Dodaj nowe wiadomości z requestu
    // Jeśli existingMessages zawiera tylko nową wiadomość użytkownika, dodaj ją na końcu
    // Jeśli existingMessages zawiera już pełną historię, użyj jej
    const newUserMessages = existingMessages.filter(m => m.role === 'user');
    const lastNewUserMessage = newUserMessages[newUserMessages.length - 1];
    
    // Sprawdź czy ostatnia wiadomość użytkownika nie jest już w pamięci
    const isLastMessageNew = lastNewUserMessage && 
      !memoryMessages.some(m => 
        m.role === 'user' && 
        m.content && 
        m.content.trim().substring(0, 50) === lastNewUserMessage.content?.trim().substring(0, 50)
      );
    
    if (isLastMessageNew) {
      // Nowa wiadomość - dodaj pamięć + nową wiadomość
      allMessages = [...allMessages, ...memoryMessages.slice(-5), ...existingMessages];
    } else {
      // Wszystkie wiadomości są już w pamięci lub request zawiera pełną historię
      allMessages = [...allMessages, ...existingMessages.length > 0 ? existingMessages : memoryMessages];
    }
    
    // Usuń duplikaty (na podstawie początku content)
    const uniqueMessages = [];
    const seen = new Set();
    allMessages.forEach(msg => {
      if (!msg.content) return;
      const contentStart = msg.content.trim().substring(0, 100);
      const key = `${msg.role}_${contentStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMessages.push(msg);
      }
    });
    
    // Ograniczenie do ostatnich 20 wiadomości (żeby nie przekroczyć limitów tokenów)
    // Ale zawsze zachowaj ostatnią wiadomość użytkownika
    let finalMessages = uniqueMessages;
    if (finalMessages.length > 20) {
      const lastUserMsg = finalMessages.filter(m => m.role === 'user').pop();
      const beforeLastUser = finalMessages.slice(0, finalMessages.indexOf(lastUserMsg));
      finalMessages = [...beforeLastUser.slice(-19), lastUserMsg];
    }
    
    // Aktualizuj userContext o preferencje z pamięci
    if (memoryContext.preferences) {
      userContext.preferences = memoryContext.preferences;
    }
    
    // Wyniki agentów pomocniczych uzupełniane po odpowiedzi Concierge.
    const agentPayload = {};

    // Pobierz profil użytkownika dla personalizacji (Faza 3)
    let userProfile = null;
    try {
      userProfile = await PersonalizationService.getUserProfile(userId);
    } catch (error) {
      console.warn('Could not load user profile, using defaults:', error.message);
      userProfile = PersonalizationService.getDefaultProfile(userId);
    }

    // Analizuj obrazy jeśli są dostępne (Faza 3 - Multi-modal)
    let imageAnalysis = null;
    if (parsed.imageUrls && parsed.imageUrls.length > 0) {
      try {
        if (parsed.imageUrls.length === 1) {
          imageAnalysis = await multiModalService.analyzeImage(
            parsed.imageUrls[0],
            'Opisz problem widoczny na obrazie. Jakiego typu usługa może być potrzebna?'
          );
        } else {
          imageAnalysis = await multiModalService.analyzeMultipleImages(
            parsed.imageUrls,
            'Opisz problemy widoczne na obrazach. Jakiego typu usługi mogą być potrzebne?'
          );
        }

        // Jeśli analiza obrazu wykryła problemy/usługi, dodaj do kontekstu
        if (imageAnalysis.success && imageAnalysis.analysis) {
          const analysis = imageAnalysis.analysis;
          
          // Dodaj do userContext
          if (analysis.serviceHints.length > 0 && !userContext.serviceHint) {
            userContext.serviceHint = analysis.serviceHints[0];
          }
          
          if (analysis.urgency && analysis.urgency !== 'standard') {
            userContext.detectedUrgency = analysis.urgency;
          }

          // Dodaj opis obrazu do ostatniej wiadomości użytkownika.
          // Adapter LLM usuwa wiadomości systemowe, więc wynik vision musi być częścią rozmowy.
          const imageContext = [
            '',
            '[WYNIK ANALIZY ZAŁĄCZONEGO ZDJĘCIA]',
            'Traktuj to jako obejrzane zdjęcie. Nie pisz użytkownikowi, że nie widzisz zdjęcia.',
            imageAnalysis.description
          ].join('\n');
          const lastUserIndex = finalMessages
            .map((msg, index) => ({ msg, index }))
            .filter(({ msg }) => msg.role === 'user')
            .pop()?.index;

          if (typeof lastUserIndex === 'number') {
            finalMessages[lastUserIndex] = {
              ...finalMessages[lastUserIndex],
              content: `${finalMessages[lastUserIndex].content || ''}\n${imageContext}`.trim()
            };
          } else {
            finalMessages.push({
              role: 'user',
              content: imageContext
            });
          }
        } else if (imageAnalysis && imageAnalysis.success === false) {
          const imageFailureContext = [
            '',
            '[STATUS ZAŁĄCZONEGO ZDJĘCIA]',
            `Nie udało się technicznie odczytać zdjęcia: ${imageAnalysis.error || 'brak szczegółów błędu'}.`,
            'Poproś krótko o opis problemu słownie i nie pokazuj od razu zlecenia ani wykonawców.'
          ].join('\n');
          const lastUserIndex = finalMessages
            .map((msg, index) => ({ msg, index }))
            .filter(({ msg }) => msg.role === 'user')
            .pop()?.index;

          if (typeof lastUserIndex === 'number') {
            finalMessages[lastUserIndex] = {
              ...finalMessages[lastUserIndex],
              content: `${finalMessages[lastUserIndex].content || ''}\n${imageFailureContext}`.trim()
            };
          }
        }
      } catch (error) {
        console.warn('Image analysis failed:', error.message);
      }
    }

    // Wywołaj Agent Concierge (orchestrator) - klasyfikacja i routing
    const conciergeResult = await runConciergeAgent({
      messages: finalMessages.length > 0 ? finalMessages : parsed.messages,
      userContext: {
        ...userContext,
        userProfile, // Dodaj profil dla personalizacji
        abVariants // Dodaj warianty A/B testing (Faza 3)
      },
      allowedServicesHint: parsed.allowedServicesHint || []
    });
    
    // Zapisz wiadomości do pamięci (async, nie czekamy)
    // Znajdź ostatnią wiadomość użytkownika z finalMessages
    const lastUserMessage = finalMessages
      .filter(m => m.role === 'user')
      .pop();

    const previousOrderDraft = getDraft(sessionId);
    const mergedDraftContext = mergeDraftContext({
      previousDraft: previousOrderDraft,
      extracted: conciergeResult.extracted || {},
      detectedService: conciergeResult.detectedService,
      urgency: conciergeResult.urgency,
      lastUserText: lastUserMessage?.content || '',
      userContext
    });

    conciergeResult.extracted = mergedDraftContext.extracted;
    conciergeResult.detectedService = mergedDraftContext.detectedService || conciergeResult.detectedService;
    conciergeResult.urgency = mergedDraftContext.urgency || conciergeResult.urgency;
    
    if (lastUserMessage && lastUserMessage.content) {
      ConversationMemoryService.addMessage(
        userId,
        sessionId,
        'user',
        lastUserMessage.content,
        'concierge',
        {},
        'concierge'
      ).catch(err => console.error('Error saving user message:', err));
    }
    
    // Zapisz odpowiedź AI
    if (conciergeResult.reply) {
      ConversationMemoryService.addMessage(
        userId,
        sessionId,
        'assistant',
        conciergeResult.reply,
        conciergeResult.agent || 'concierge',
        {
          nextStep: conciergeResult.nextStep,
          detectedService: conciergeResult.detectedService,
          urgency: conciergeResult.urgency,
          agents: Object.keys(agentPayload)
        },
        'concierge'
      ).catch(err => console.error('Error saving assistant message:', err));
    }
    
    // Aktualizuj ostatnią interakcję
    ConversationMemoryService.updateLastInteraction(userId, sessionId, {
      detectedService: conciergeResult.detectedService,
      urgency: conciergeResult.urgency,
      location: conciergeResult.extracted?.location || userContext.location?.text,
      nextStep: conciergeResult.nextStep
    }, 'concierge').catch(err => console.error('Error updating last interaction:', err));
    
    // Wyekstraktuj i zapisz preferencje jeśli wykryto
    if (conciergeResult.detectedService || conciergeResult.extracted?.location) {
      const preferences = {};
      if (conciergeResult.detectedService) {
        preferences.preferredServices = [conciergeResult.detectedService];
      }
      if (conciergeResult.extracted?.location || userContext.location?.text) {
        preferences.preferredLocations = [conciergeResult.extracted?.location || userContext.location?.text];
      }
      ConversationMemoryService.updatePreferences(userId, sessionId, preferences, 'concierge')
        .catch(err => console.error('Error updating preferences:', err));
    }

    // Web Search Integration (Faza 3) - sprawdź czy potrzebne wyszukiwanie
    let webSearchResults = null;
    const userMessageText = lastUserMessage?.content || '';

    if (WebSearchIntegrationService.shouldSearchWeb(
      userMessageText,
      conciergeResult.detectedService,
      conciergeResult.confidence || 0.8
    )) {
      try {
        webSearchResults = await WebSearchIntegrationService.searchForProblem(
          userMessageText,
          conciergeResult.detectedService
        );
      } catch (error) {
        console.warn('Web search failed:', error.message);
      }
    }

    // Routing do innych agentów na podstawie nextStep
    // Agent Diagnostyczny - ocena ryzyka/pilności
    if (conciergeResult.nextStep === 'diagnose') {
      try {
        agentPayload.diagnostic = await runDiagnosticAgent({
          messages: parsed.messages,
          detectedService: conciergeResult.detectedService,
          userContext
        });
        
        // Zaktualizuj urgency i recommendedPath z diagnostyki
        if (agentPayload.diagnostic.urgency) {
          conciergeResult.urgency = agentPayload.diagnostic.urgency;
        }
        if (agentPayload.diagnostic.recommendedPath) {
          // Mapuj recommendedPath na nextStep
          const pathToStep = {
            'express': 'suggest_providers',
            'provider': 'suggest_providers',
            'diy': 'suggest_diy',
            'teleconsult': 'show_pricing'
          };
          if (pathToStep[agentPayload.diagnostic.recommendedPath]) {
            conciergeResult.nextStep = pathToStep[agentPayload.diagnostic.recommendedPath];
          }
        }
        // Zaktualizuj safety flags
        if (agentPayload.diagnostic.safety?.flag) {
          conciergeResult.safety = agentPayload.diagnostic.safety;
        }
      } catch (error) {
        console.error('Diagnostic agent failed:', error.message);
      }
    }
    
    // Agent Kosztowy - widełki cenowe
    if (conciergeResult.nextStep === 'show_pricing') {
      try {
        agentPayload.pricing = await runPricingAgent({
          service: conciergeResult.detectedService,
          urgency: conciergeResult.urgency || 'standard',
          userContext,
          budget: conciergeResult.extracted?.budget
        });
      } catch (error) {
        console.error('Pricing agent failed:', error.message);
      }
    }
    
    // Agent DIY - instrukcje krok po kroku
    if (conciergeResult.nextStep === 'suggest_diy') {
      try {
        agentPayload.diy = await runDIYAgent({
          service: conciergeResult.detectedService,
          messages: parsed.messages
        });
      } catch (error) {
        console.error('DIY agent failed:', error.message);
      }
    }
    
    // Agent Matching - znajdź wykonawców
    if (conciergeResult.nextStep === 'suggest_providers') {
      try {
        agentPayload.matching = await runMatchingAgent({
          service: conciergeResult.detectedService,
          urgency: conciergeResult.urgency || 'standard',
          budget: conciergeResult.extracted?.budget,
          userContext
        });
      } catch (error) {
        console.error('Matching agent failed:', error.message);
      }
    }
    
    // Agent Order Draft - przygotuj lub aktualizuj draft zlecenia przy każdej rozmowie usługowej.
    const shouldBuildOrderDraft = ['service_request', 'pricing', 'providers', 'diy'].includes(conciergeResult.intent)
      || ['ask_more', 'diagnose', 'show_pricing', 'suggest_diy', 'suggest_providers', 'create_order'].includes(conciergeResult.nextStep);
    if (shouldBuildOrderDraft) {
      try {
        agentPayload.orderDraft = await runOrderDraftAgent({
          messages: finalMessages.length > 0 ? finalMessages : parsed.messages,
          extracted: mergedDraftContext.extracted,
          detectedService: conciergeResult.detectedService,
          urgency: conciergeResult.urgency || 'standard'
        });
        agentPayload.orderDraft = attachStoredContext(agentPayload.orderDraft, mergedDraftContext);
        saveDraft(sessionId, agentPayload.orderDraft);
        if (agentPayload.orderDraft.canCreate && conciergeResult.nextStep === 'ask_more') {
          conciergeResult.nextStep = 'create_order';
        }
        if (agentPayload.orderDraft.nextQuestion) {
          conciergeResult.questions = [agentPayload.orderDraft.nextQuestion];
        } else if (agentPayload.orderDraft.questions?.length && (!conciergeResult.questions || conciergeResult.questions.length === 0)) {
          conciergeResult.questions = agentPayload.orderDraft.questions.slice(0, 1);
        }
      } catch (error) {
        console.error('Order draft agent failed:', error.message);
      }
    }

    // Personalizuj odpowiedź (Faza 3)
    let finalResult = conciergeResult;
    if (userProfile) {
      finalResult = PersonalizationService.personalizeResponse(
        { ...conciergeResult },
        userProfile
      );
    }

    // Wzbogać o wyniki wyszukiwania (Faza 3)
    if (webSearchResults && webSearchResults.success) {
      finalResult = WebSearchIntegrationService.enrichResponseWithSearch(
        finalResult,
        webSearchResults
      );
    }

    // Aktualizuj profil na podstawie interakcji (Faza 3)
    PersonalizationService.updateProfileFromInteraction(userId, {
      sessionId,
      detectedService: conciergeResult.detectedService,
      location: conciergeResult.extracted?.location || userContext.location?.text,
      urgency: conciergeResult.urgency
    }).catch(err => console.error('Error updating profile:', err));

    // Generuj messageId dla feedbacku
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    // Oblicz response time
    const responseTime = Date.now() - startTime;
    
    // Track analytics (async, nie czekamy)
    const agentChain = ['concierge', ...Object.keys(agentPayload)];
    AIAnalyticsService.trackRequest({
      requestId,
      userId,
      sessionId,
      agent: 'concierge',
      agentChain,
      endpoint: '/api/ai/concierge/v2',
      requestSize: JSON.stringify(req.body).length,
      messageCount: finalMessages.length,
      responseTime,
      success: true,
      llmProvider: 'claude',
      tokensInput: 0, // Będzie uzupełnione jeśli dostępne
      tokensOutput: 0,
      quality: {
        confidence: conciergeResult.confidence || 0.8
      },
      metadata: {
        detectedService: conciergeResult.detectedService,
        urgency: conciergeResult.urgency,
        nextStep: conciergeResult.nextStep,
        agentsCalled: agentChain,
        personalized: !!userProfile,
        webSearchPerformed: !!webSearchResults,
        imageAnalysisPerformed: !!imageAnalysis
      }
    }).catch(err => console.error('Error tracking analytics:', err));
    
    return res.json({
      ok: true,
      agent: 'concierge',
      result: finalResult, // Spersonalizowana odpowiedź
      agents: agentPayload, // Wyniki innych agentów
      // Backward compatibility - mapuj na format podobny do obecnego
      serviceCandidate: finalResult.detectedService ? {
        code: finalResult.detectedService,
        name: finalResult.detectedService,
        confidence: finalResult.confidence
      } : null,
      urgency: finalResult.urgency,
      nextStep: finalResult.nextStep,
      // Dla frontendu - odpowiedź tekstowa
      reply: finalResult.reply,
      toolUsed: finalResult.toolUsed || null,
      toolResult: finalResult.toolResult || null,
      questions: finalResult.questions,
      extracted: finalResult.extracted,
      safety: finalResult.safety,
      diagnosticFlow: finalResult.diagnosticFlow || null,
      // Nowe pola dla Memory i Feedback
      sessionId: sessionId,
      messageId: messageId,
      requestId: requestId, // Dla trackingu
      memory: {
        hasHistory: memoryContext.recentMessages.length > 0,
        hasSummary: !!memoryContext.summary,
        preferences: memoryContext.preferences
      },
      // Faza 3 - nowe pola
      personalized: !!userProfile,
      imageAnalysis: imageAnalysis?.success ? {
        description: imageAnalysis.description,
        detectedProblems: imageAnalysis.analysis?.problems || [],
        serviceHints: imageAnalysis.analysis?.serviceHints || []
      } : null,
      webSearch: webSearchResults?.success ? {
        performed: true,
        resultsCount: webSearchResults.results.length,
        topResults: webSearchResults.results.slice(0, 2)
      } : null
    });

  } catch (error) {
    console.error('AI Concierge Handler error:', error);
    console.error('Error stack:', error.stack);
    
    // Track error analytics
    const responseTime = Date.now() - startTime;
    const AIAnalyticsService = require('../services/AIAnalyticsService');
    const errorType = error.message?.includes('401') ? 'auth_error' :
                     error.message?.includes('timeout') ? 'timeout' :
                     error.message?.includes('rate limit') ? 'rate_limit' :
                     error.message?.includes('validation') ? 'validation_error' :
                     error.message?.includes('LLM') ? 'llm_error' : 'other';
    
    AIAnalyticsService.trackRequest({
      requestId: requestId || AIAnalyticsService.generateRequestId(),
      userId: req.user?.id || req.user?._id || null,
      sessionId: req.body.sessionId || 'unknown',
      agent: 'concierge',
      endpoint: '/api/ai/concierge/v2',
      responseTime,
      success: false,
      error: error.message?.substring(0, 500),
      errorType,
      metadata: { stack: error.stack?.substring(0, 1000) }
    }).catch(err => console.error('Error tracking error analytics:', err));
    
    // Ukryj szczegóły błędów przed użytkownikiem
    const isAuthError = error.message?.includes('401') || 
                       error.message?.includes('authentication') ||
                       error.message?.includes('invalid x-api-key');
    
    const userFriendlyMessage = isAuthError
      ? 'Wystąpił problem z konfiguracją AI. Proszę spróbować ponownie później.'
      : 'Błąd podczas przetwarzania żądania AI. Spróbuj ponownie.';
    
    if (!isAuthError) {
      const { detectApplianceIssue } = require('./utils/applianceDiagnostics');
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      const text = lastUserMessage?.content || req.body?.description || '';
      const applianceIssue = detectApplianceIssue(text);
      if (applianceIssue) {
        return res.json({
          ok: true,
          agent: 'concierge',
          result: {
            ok: true,
            agent: 'concierge',
            reply: applianceIssue.reply,
            intent: 'service_request',
            detectedService: applianceIssue.service,
            urgency: applianceIssue.urgency,
            confidence: applianceIssue.confidence,
            nextStep: applianceIssue.nextStep,
            questions: applianceIssue.questions,
            extracted: {
              location: null,
              timeWindow: null,
              budget: null,
              details: applianceIssue.details
            },
            missing: applianceIssue.questions,
            safety: applianceIssue.safety
          },
          agents: {},
          serviceCandidate: {
            code: applianceIssue.service,
            name: applianceIssue.service,
            confidence: applianceIssue.confidence
          },
          urgency: applianceIssue.urgency,
          nextStep: applianceIssue.nextStep,
          reply: applianceIssue.reply,
          questions: applianceIssue.questions,
          extracted: {
            location: null,
            timeWindow: null,
            budget: null,
            details: applianceIssue.details
          },
          safety: applianceIssue.safety
        });
      }
    }
    
    return res.status(500).json({
      ok: false,
      error: 'AI_CONCIERGE_FAILED',
      message: userFriendlyMessage,
      result: {
        reply: userFriendlyMessage,
        nextStep: 'ask_more',
        questions: ['Czy możesz opisać problem dokładniej?']
      },
      agents: {}
      // Nie zwracamy error.message do klienta - szczegóły tylko w logach
    });
  }
}

module.exports = {
  conciergeHandler,
  runConciergeAgent
};

