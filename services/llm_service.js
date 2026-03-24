// backend/services/llm_service.js
// Główny serwis LLM z integracją Claude 3.5 i fallbackiem do Ollama

const claudeService = require('./claude');
const { analyzeWithOllama } = require('./llm_local');

class LLMService {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'claude';
    this.fallbackEnabled = process.env.LLM_FALLBACK_ENABLED !== 'false';
  }

  async analyzeProblem({ description, imageUrls = [], lang = 'pl', enableWebSearch = false, priceHints = null, locationText = null, similarOrders = [], successfulFeedback = [], availableParts = [], cityMultiplier = null, conversationHistory = [] }) {
    console.log(`🤖 LLM Service: Using provider: ${this.provider}`);
    
    // Spróbuj Claude jako główny dostawca
    if (this.provider === 'claude' || this.provider === 'auto') {
      try {
        console.log('🚀 Attempting Claude 3.5 analysis...');
        const result = await claudeService.analyzeWithClaude({
          description,
          imageUrls,
          lang,
          enableWebSearch,
          priceHints,
          locationText,
          similarOrders,
          successfulFeedback,
          availableParts,
          cityMultiplier,
          conversationHistory
        });
        
        console.log('✅ Claude 3.5 analysis successful');
        return this.normalizeResponse(result, 'claude');
      } catch (error) {
        console.warn('⚠️ Claude 3.5 failed:', error.message);
        
        if (this.fallbackEnabled && this.provider === 'auto') {
          console.log('🔄 Falling back to Ollama...');
          return await this.fallbackToOllama({ description, imageUrls, lang, priceHints, locationText, similarOrders, availableParts });
        } else {
          throw error;
        }
      }
    }
    
    // Użyj Ollama jako główny dostawca
    if (this.provider === 'ollama') {
      return await this.fallbackToOllama({ description, imageUrls, lang, priceHints, locationText, similarOrders, availableParts });
    }
    
    throw new Error(`Unknown LLM provider: ${this.provider}`);
  }

  async fallbackToOllama({ description, imageUrls, lang }) {
    try {
      console.log('🦙 Using Ollama fallback...');
      const result = await analyzeWithOllama({
        description,
        imageUrls,
        lang
      });
      
      console.log('✅ Ollama analysis successful');
      return this.normalizeResponse(result, 'ollama');
    } catch (error) {
      console.error('❌ Ollama fallback failed:', error.message);
      throw error;
    }
  }

  normalizeResponse(result, provider) {
    // Normalizuj odpowiedź z różnych dostawców do wspólnego formatu
    return {
      // Podstawowe informacje
      serviceCandidate: result.serviceCandidate || {
        code: 'inne',
        name: 'Inne usługi',
        confidence: 0.5
      },
      
      // Kroki DIY
      diySteps: result.diySteps || [],
      
      // Flagi zagrożeń
      dangerFlags: result.dangerFlags || [],
      
      // Pilność
      urgency: result.urgency || 'normal',
      
      // Szacowany koszt
      estimatedCost: result.estimatedCost || {
        min: null,
        max: null,
        currency: 'PLN'
      },
      
      // Szacowany czas
      estimatedTime: result.estimatedTime || '1-3 dni',
      
      // Typ wykonawcy
      providerType: result.providerType || 'both',
      
      // Części (tylko dla Ollama)
      parts: result.parts || [],
      
      // Język
      language: result.language || 'pl',
      
      // Metadane
      provider: provider,
      timestamp: new Date().toISOString(),
      
      // Surowa odpowiedź (dla debugowania)
      rawResponse: result.rawResponse || null
    };
  }

  // Test połączenia z wszystkimi dostawcami
  async testConnections() {
    const results = {
      claude: { enabled: false, status: 'disabled' },
      ollama: { enabled: false, status: 'disabled' }
    };

    // Test Claude
    if (claudeService.isEnabled) {
      try {
        const claudeTest = await claudeService.testConnection();
        results.claude = {
          enabled: true,
          status: claudeTest.success ? 'connected' : 'error',
          message: claudeTest.success ? claudeTest.message : claudeTest.error
        };
      } catch (error) {
        results.claude = {
          enabled: true,
          status: 'error',
          message: error.message
        };
      }
    }

    // Test Ollama
    try {
      const ollamaTest = await this.testOllamaConnection();
      results.ollama = {
        enabled: true,
        status: ollamaTest.success ? 'connected' : 'error',
        message: ollamaTest.success ? ollamaTest.message : ollamaTest.error
      };
    } catch (error) {
      results.ollama = {
        enabled: true,
        status: 'error',
        message: error.message
      };
    }

    return results;
  }

  async testOllamaConnection() {
    try {
      const result = await analyzeWithOllama({
        description: 'Test connection',
        imageUrls: [],
        lang: 'pl'
      });
      
      return {
        success: true,
        message: 'Ollama connection successful',
        response: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Pobierz status wszystkich dostawców
  getStatus() {
    return {
      provider: this.provider,
      fallbackEnabled: this.fallbackEnabled,
      claude: {
        enabled: claudeService.isEnabled
      },
      ollama: {
        enabled: true // Ollama jest zawsze dostępny jako fallback
      }
    };
  }
}

// Eksportuj singleton
const llmService = new LLMService();
module.exports = llmService;
