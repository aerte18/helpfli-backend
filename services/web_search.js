// backend/services/web_search.js
// Serwis wyszukiwania internetowego dla AI Concierge

const axios = require('axios');

class WebSearchService {
  constructor() {
    this.providers = {
      bing: {
        enabled: !!process.env.BING_API_KEY,
        apiKey: process.env.BING_API_KEY,
        endpoint: 'https://api.bing.microsoft.com/v7.0/search'
      },
      serpapi: {
        enabled: !!process.env.SERPAPI_KEY,
        apiKey: process.env.SERPAPI_KEY,
        endpoint: 'https://serpapi.com/search'
      },
      perplexity: {
        enabled: !!process.env.PERPLEXITY_API_KEY,
        apiKey: process.env.PERPLEXITY_API_KEY,
        endpoint: 'https://api.perplexity.ai/chat/completions'
      }
    };
    
    this.defaultProvider = process.env.WEB_SEARCH_PROVIDER || 'bing';
    this.fallbackEnabled = process.env.WEB_SEARCH_FALLBACK_ENABLED !== 'false';
    
    console.log('🔍 Web Search Service initialized:', {
      providers: Object.keys(this.providers).filter(p => this.providers[p].enabled),
      defaultProvider: this.defaultProvider,
      fallbackEnabled: this.fallbackEnabled
    });
  }

  async search(query, options = {}) {
    const {
      provider = this.defaultProvider,
      lang = 'pl',
      count = 5,
      safeSearch = 'Moderate'
    } = options;

    console.log(`🔍 Web Search: "${query}" using ${provider}`);

    // Spróbuj głównego dostawcy
    if (this.providers[provider]?.enabled) {
      try {
        const result = await this.searchWithProvider(provider, query, { lang, count, safeSearch });
        console.log(`✅ Web Search successful with ${provider}`);
        return result;
      } catch (error) {
        console.warn(`⚠️ Web Search failed with ${provider}:`, error.message);
        
        if (this.fallbackEnabled) {
          return await this.fallbackSearch(query, { lang, count, safeSearch }, provider);
        } else {
          throw error;
        }
      }
    }

    // Fallback do innych dostawców
    if (this.fallbackEnabled) {
      return await this.fallbackSearch(query, { lang, count, safeSearch });
    }

    throw new Error(`No web search providers available`);
  }

  async searchWithProvider(provider, query, options) {
    switch (provider) {
      case 'bing':
        return await this.searchBing(query, options);
      case 'serpapi':
        return await this.searchSerpAPI(query, options);
      case 'perplexity':
        return await this.searchPerplexity(query, options);
      default:
        throw new Error(`Unknown search provider: ${provider}`);
    }
  }

  async searchBing(query, options) {
    const { lang, count, safeSearch } = options;
    
    const response = await axios.get(this.providers.bing.endpoint, {
      headers: {
        'Ocp-Apim-Subscription-Key': this.providers.bing.apiKey
      },
      params: {
        q: query,
        count: count,
        mkt: lang === 'pl' ? 'pl-PL' : 'en-US',
        safeSearch: safeSearch,
        responseFilter: 'WebPages'
      },
      timeout: 10000
    });

    const results = response.data.webPages?.value || [];
    
    return {
      provider: 'bing',
      query,
      results: results.map(item => ({
        title: item.name,
        url: item.url,
        snippet: item.snippet,
        displayUrl: item.displayUrl,
        dateLastCrawled: item.dateLastCrawled
      })),
      totalResults: response.data.webPages?.totalEstimatedMatches || 0
    };
  }

  async searchSerpAPI(query, options) {
    const { lang, count } = options;
    
    const response = await axios.get(this.providers.serpapi.endpoint, {
      params: {
        api_key: this.providers.serpapi.apiKey,
        q: query,
        engine: 'google',
        hl: lang === 'pl' ? 'pl' : 'en',
        gl: lang === 'pl' ? 'pl' : 'us',
        num: count,
        safe: 'active'
      },
      timeout: 15000
    });

    const results = response.data.organic_results || [];
    
    return {
      provider: 'serpapi',
      query,
      results: results.map(item => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        displayUrl: item.displayed_link,
        dateLastCrawled: item.date
      })),
      totalResults: response.data.search_information?.total_results || 0
    };
  }

  async searchPerplexity(query, options) {
    const { lang, count } = options;
    
    const response = await axios.post(this.providers.perplexity.endpoint, {
      model: 'llama-3.1-sonar-small-128k-online',
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that provides web search results. Search for: ${query}. 
          Provide ${count} relevant results with titles, URLs, and snippets. 
          Focus on ${lang === 'pl' ? 'Polish' : 'English'} content when possible.`
        },
        {
          role: 'user',
          content: `Search for: ${query}`
        }
      ],
      max_tokens: 1000,
      temperature: 0.2
    }, {
      headers: {
        'Authorization': `Bearer ${this.providers.perplexity.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });

    // Perplexity zwraca tekst, więc musimy go sparsować
    const content = response.data.choices[0].message.content;
    const results = this.parsePerplexityResults(content, count);
    
    return {
      provider: 'perplexity',
      query,
      results,
      totalResults: results.length
    };
  }

  parsePerplexityResults(content, maxResults) {
    const results = [];
    const lines = content.split('\n');
    
    let currentResult = null;
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.match(/^\d+\./)) {
        // Nowy wynik
        if (currentResult) {
          results.push(currentResult);
        }
        currentResult = {
          title: trimmed.replace(/^\d+\.\s*/, ''),
          url: '',
          snippet: '',
          displayUrl: ''
        };
      } else if (currentResult && trimmed.startsWith('http')) {
        currentResult.url = trimmed;
        currentResult.displayUrl = trimmed;
      } else if (currentResult && trimmed.length > 0 && !trimmed.startsWith('http')) {
        currentResult.snippet = (currentResult.snippet + ' ' + trimmed).trim();
      }
      
      if (results.length >= maxResults) break;
    }
    
    if (currentResult) {
      results.push(currentResult);
    }
    
    return results.slice(0, maxResults);
  }

  async fallbackSearch(query, options, excludeProvider = null) {
    const availableProviders = Object.keys(this.providers).filter(
      p => this.providers[p].enabled && p !== excludeProvider
    );
    
    for (const provider of availableProviders) {
      try {
        console.log(`🔄 Fallback to ${provider}...`);
        const result = await this.searchWithProvider(provider, query, options);
        console.log(`✅ Fallback successful with ${provider}`);
        return result;
      } catch (error) {
        console.warn(`⚠️ Fallback failed with ${provider}:`, error.message);
      }
    }
    
    throw new Error('All web search providers failed');
  }

  // Test połączenia z wszystkimi dostawcami
  async testConnections() {
    const results = {};
    
    for (const [provider, config] of Object.entries(this.providers)) {
      if (config.enabled) {
        try {
          const testResult = await this.searchWithProvider(provider, 'test', { count: 1 });
          results[provider] = {
            enabled: true,
            status: 'connected',
            message: 'Connection successful'
          };
        } catch (error) {
          results[provider] = {
            enabled: true,
            status: 'error',
            message: error.message
          };
        }
      } else {
        results[provider] = {
          enabled: false,
          status: 'disabled',
          message: 'API key not configured'
        };
      }
    }
    
    return results;
  }

  // Pobierz status wszystkich dostawców
  getStatus() {
    return {
      defaultProvider: this.defaultProvider,
      fallbackEnabled: this.fallbackEnabled,
      providers: Object.fromEntries(
        Object.entries(this.providers).map(([name, config]) => [
          name,
          { enabled: config.enabled }
        ])
      )
    };
  }

  // Wyszukaj informacje o usługach/remontach
  async searchServiceInfo(serviceName, location = null) {
    const queries = [
      `${serviceName} cennik ceny`,
      `${serviceName} jak znaleźć wykonawcę`,
      `${serviceName} porady DIY`
    ];
    
    if (location) {
      queries.push(`${serviceName} ${location} wykonawcy`);
    }
    
    const results = [];
    for (const query of queries) {
      try {
        const searchResult = await this.search(query, { count: 3 });
        results.push({
          query,
          results: searchResult.results
        });
      } catch (error) {
        console.warn(`Search failed for query: ${query}`, error.message);
      }
    }
    
    return results;
  }
}

// Eksportuj singleton
const webSearchService = new WebSearchService();
module.exports = webSearchService;
