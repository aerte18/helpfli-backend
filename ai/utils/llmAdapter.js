/**
 * Adapter do wywołań LLM
 * Integruje się z istniejącym llm_service.js
 * Wspiera różne typy agentów i wymusza JSON response
 */

const llmService = require('../../services/llm_service');
const ErrorRecoveryService = require('../../services/ErrorRecoveryService');
const CacheService = require('../../services/CacheService');

/**
 * Wywołanie LLM dla agenta z obsługą Tool Calling
 * Używa bezpośredniego wywołania Claude z wymuszonym JSON
 * @param {Object} params
 * @param {string} params.systemPrompt - Prompt systemowy dla agenta
 * @param {Array} params.messages - Historia konwersacji
 * @param {string} params.agentType - Typ agenta (concierge, diagnostic, pricing, etc.)
 * @param {Object} params.context - Dodatkowy kontekst (location, service, userId, etc.)
 * @param {boolean} params.enableTools - Czy włączyć tool calling (domyślnie false)
 * @returns {Promise<Object>} Zparsowany JSON response lub tool call result
 */
async function callAgentLLM({ systemPrompt, messages, agentType = 'concierge', context = {}, enableTools = false }) {
  try {
    // Dla agentów wymagających strukturyzowanego JSON, użyj bezpośredniego wywołania Claude
    // Dla prostszych przypadków (tylko description), możemy użyć istniejącego llm_service
    
    const useDirectCall = agentType === 'concierge' || agentType === 'diagnostic' || agentType === 'pricing';
    const hasValidApiKey = process.env.ANTHROPIC_API_KEY && 
                          process.env.ANTHROPIC_API_KEY.trim().length > 20 &&
                          process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-');
    
    // Jeśli włączone tools, użyj callLLMWithTools
    if (enableTools && hasValidApiKey) {
      try {
        return await callLLMWithTools(systemPrompt, messages, agentType, context);
      } catch (error) {
        console.warn('⚠️ Tool calling failed, falling back to JSON format:', error.message);
        // Fallback do normalnego JSON
      }
    }
    
    if (useDirectCall && hasValidApiKey) {
      try {
        // Sprawdź cache dla podobnych zapytań
        const cachedResponse = await CacheService.getSimilarQuery(messages);
        if (cachedResponse) {
          console.log('✅ Cache hit for similar query');
          return cachedResponse;
        }

        // Bezpośrednie wywołanie Claude z wymuszonym JSON (z retry)
        const response = await ErrorRecoveryService.retry(
          () => callLLMWithJSONFormat(systemPrompt, messages),
          {
            maxRetries: 2,
            shouldRetry: (error) => {
              return error.message?.includes('timeout') ||
                     error.message?.includes('rate limit') ||
                     error.status === 429 ||
                     error.status === 503;
            }
          }
        );

        // Zapisz w cache (10 minut)
        await CacheService.setSimilarQuery(messages, response, 600);

        return response;
      } catch (error) {
        // Jeśli bezpośrednie wywołanie nie działa (np. 401), użyj fallback
        console.warn('⚠️ Direct Claude call failed, using llm_service fallback:', error.message);
      }
    }
    
    // Fallback: użyj istniejącego llm_service
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    
    if (!lastUserMessage) {
      throw new Error('No user message found');
    }
    
    const description = lastUserMessage.content || lastUserMessage.text || '';
    
    const result = await llmService.analyzeProblem({
      description,
      imageUrls: context.imageUrls || [],
      lang: context.lang || 'pl',
      enableWebSearch: context.enableWebSearch || false,
      priceHints: context.priceHints || null,
      locationText: context.locationText || context.location?.text || null,
      similarOrders: context.similarOrders || [],
      successfulFeedback: context.successfulFeedback || [],
      availableParts: context.availableParts || [],
      cityMultiplier: context.cityMultiplier || null,
      conversationHistory: messages
    });

    // Zwróć result (mapowanie na format agenta będzie w konkretnym agencie)
    return result;

  } catch (error) {
    console.error(`❌ Error calling LLM for agent ${agentType}:`, error.message);
    console.error('Error details:', {
      agentType,
      hasMessages: messages && messages.length > 0,
      messageCount: messages?.length || 0,
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      errorStack: error.stack
    });
    throw new Error(`LLM call failed for ${agentType}: ${error.message}`);
  }
}

/**
 * Wywołanie LLM z wymuszonym JSON response
 * Bezpośrednie wywołanie Claude API z wymuszonym formatem JSON
 * @param {string} systemPrompt 
 * @param {Array} messages 
 * @returns {Promise<Object>} Parsed JSON
 */
async function callLLMWithJSONFormat(systemPrompt, messages) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not found');
    }
    
    const client = new Anthropic({ apiKey });
    
    // Przygotuj pełną konwersację z system promptem
    const fullMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m === 'string' ? m : (m.content || m.text || '')
      }));
    
    // Wzmocnij prompt o wymuszenie JSON
    const enhancedSystemPrompt = `${systemPrompt}

KRYTYCZNE: Odpowiedz WYŁĄCZNIE w formacie JSON. Nie dodawaj żadnego tekstu przed ani po JSON.
JSON powinien być poprawny, parsowalny, bez dodatkowych znaków, bez markdown code blocks.
Zacznij odpowiedź bezpośrednio od { i zakończ na }.`;

    const response = await client.messages.create({
      model: process.env.CLAUDE_DEFAULT || 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      temperature: 0.4,
      system: enhancedSystemPrompt,
      messages: fullMessages
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    const text = content.text.trim();
    
    // Parsuj JSON
    const parsed = safeParseJSON(text);
    
    if (!parsed || typeof parsed !== 'object') {
      console.error('Failed to parse Claude response as JSON:', text.substring(0, 500));
      throw new Error('LLM did not return valid JSON');
    }
    
    return parsed;
    
  } catch (error) {
    // Sprawdź typ błędu - 401 oznacza nieprawidłowy klucz API
    const isAuthError = error.message?.includes('401') || 
                       error.message?.includes('authentication_error') ||
                       error.message?.includes('invalid x-api-key') ||
                       error?.status === 401;
    
    if (isAuthError) {
      console.error('❌ Claude API authentication error - invalid API key');
      console.error('⚠️  Sprawdź czy ANTHROPIC_API_KEY jest poprawny w backend/.env');
      console.error('⚠️  Klucz powinien zaczynać się od: sk-ant-api03-...');
    } else {
      console.error('❌ Error in callLLMWithJSONFormat:', error.message);
      console.error('Error details:', {
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        apiKeyLength: process.env.ANTHROPIC_API_KEY?.length || 0,
        messageCount: messages?.length || 0
      });
    }
    
    // Fallback: użyj llm_service jeśli bezpośrednie wywołanie nie działa
    console.log('⚠️ Falling back to llm_service (nie używa Claude API bezpośrednio)...');
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    
    if (!lastUserMessage) {
      // Jeśli nie ma fallbacku, rzuć uproszczony błąd (bez szczegółów)
      throw new Error(isAuthError 
        ? 'Claude API authentication failed - using fallback' 
        : 'LLM call failed - using fallback');
    }
    
    const description = lastUserMessage.content || lastUserMessage.text || '';
    const result = await llmService.analyzeProblem({
      description,
      lang: 'pl',
      conversationHistory: messages
    });
    
    return result;
  }
}

/**
 * Bezpieczne parsowanie JSON z odpowiedzi LLM
 * @param {string} text - Tekst odpowiedzi
 * @returns {Object|null} Parsed JSON lub null
 */
function safeParseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  
  try {
    return JSON.parse(text);
  } catch (e) {
    // Spróbuj wyciągnąć JSON z markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e2) {
        // Ignore
      }
    }
    
    // Spróbuj znaleźć pierwszy obiekt JSON w tekście
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (e3) {
        // Ignore
      }
    }
  }
  
  return null;
}

/**
 * Wywołanie LLM z obsługą Tool Calling
 * @param {string} systemPrompt 
 * @param {Array} messages 
 * @param {string} agentType 
 * @param {Object} context - userId, etc.
 * @returns {Promise<Object>} Response z możliwym tool call
 */
async function callLLMWithTools(systemPrompt, messages, agentType, context = {}) {
  try {
    const toolRegistry = require('./toolRegistry');
    const Anthropic = require('@anthropic-ai/sdk');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not found');
    }
    
    const client = new Anthropic({ apiKey });
    
    // Pobierz dostępne narzędzia dla agenta
    const tools = toolRegistry.getToolsSchema(agentType);
    
    // Jeśli brak narzędzi, użyj normalnego wywołania
    if (tools.length === 0) {
      return await callLLMWithJSONFormat(systemPrompt, messages);
    }
    
    // Przygotuj wiadomości
    const fullMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m === 'string' ? m : (m.content || m.text || '')
      }));
    
    // Wywołaj Claude z tools
    const response = await client.messages.create({
      model: process.env.CLAUDE_DEFAULT || 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      temperature: 0.4,
      system: systemPrompt,
      messages: fullMessages,
      tools: tools
    });
    
    // Sprawdź czy Claude chce wywołać narzędzie
    const content = response.content[0];
    
    if (content.type === 'tool_use') {
      // Claude chce wywołać narzędzie
      const toolName = content.name;
      const toolInput = content.input;
      
      // Wykonaj narzędzie
      const toolResult = await toolRegistry.execute(toolName, toolInput, {
        agentType,
        userId: context.userId,
        ...context
      });
      
      // Przygotuj odpowiedź tool result dla Claude
      const toolMessages = [
        ...fullMessages,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: content.id,
              name: toolName,
              input: toolInput
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: content.id,
              content: JSON.stringify(toolResult)
            }
          ]
        }
      ];
      
      // Druga runda - Claude z wynikiem narzędzia
      const finalResponse = await client.messages.create({
        model: process.env.CLAUDE_DEFAULT || 'claude-3-5-haiku-20241022',
        max_tokens: 2000,
        temperature: 0.4,
        system: systemPrompt,
        messages: toolMessages,
        tools: tools
      });
      
      // Zwróć odpowiedź (może być kolejny tool call lub final response)
      const finalContent = finalResponse.content[0];
      
      if (finalContent.type === 'text') {
        // Finalna odpowiedź tekstowa
        return {
          type: 'text',
          response: finalContent.text,
          toolUsed: toolName,
          toolResult: toolResult
        };
      } else if (finalContent.type === 'tool_use') {
        // Kolejny tool call - rekurencyjnie (ale max 2 iteracje dla bezpieczeństwa)
        // Na razie zwróć pierwszy tool result
        return {
          type: 'tool_result',
          toolUsed: toolName,
          toolResult: toolResult,
          response: `Wykonano akcję: ${toolName}`
        };
      }
    } else if (content.type === 'text') {
      // Normalna odpowiedź tekstowa (bez tool call)
      return {
        type: 'text',
        response: content.text
      };
    }
    
    throw new Error('Unexpected response type from Claude');
    
  } catch (error) {
    console.error('Error in callLLMWithTools:', error);
    // Fallback do normalnego wywołania
    return await callLLMWithJSONFormat(systemPrompt, messages);
  }
}

/**
 * Streamowanie odpowiedzi z Claude API
 * @param {string} systemPrompt 
 * @param {Array} messages 
 * @param {Function} onToken - Callback dla każdego tokenu (chunk: string)
 * @returns {Promise<Object>} Final response metadata
 */
async function streamLLM(systemPrompt, messages, onToken) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not found');
    }
    
    const client = new Anthropic({ apiKey });
    
    // Przygotuj wiadomości
    const fullMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m === 'string' ? m : (m.content || m.text || '')
      }));
    
    // Streaming call
    const stream = await client.messages.stream({
      model: process.env.CLAUDE_DEFAULT || 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      temperature: 0.4,
      system: systemPrompt,
      messages: fullMessages
    });
    
    let fullText = '';
    
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullText += chunk;
        if (onToken) {
          onToken(chunk);
        }
      }
    }
    
    return {
      text: fullText,
      finishReason: 'stop'
    };
    
  } catch (error) {
    console.error('Error in streamLLM:', error);
    throw error;
  }
}

module.exports = {
  callAgentLLM,
  callLLMWithJSONFormat,
  callLLMWithTools,
  streamLLM,
  safeParseJSON
};

