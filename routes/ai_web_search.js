// backend/routes/ai_web_search.js
// Endpointy do testowania i zarządzania wyszukiwaniem internetowym

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const webSearchService = require('../services/web_search');

// GET /api/ai/web-search/status - Status wyszukiwania internetowego
router.get('/status', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const status = webSearchService.getStatus();
    const connections = await webSearchService.testConnections();
    
    res.json({
      success: true,
      status,
      connections,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Web search status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/web-search/test - Test wyszukiwania internetowego
router.post('/test', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { query, provider, lang = 'pl' } = req.body;
    
    if (!query || query.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Query must be at least 3 characters long'
      });
    }

    console.log('🔍 Testing web search:', { query, provider, lang });

    const result = await webSearchService.search(query, {
      provider,
      lang,
      count: 5
    });

    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Web search test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/web-search/service-info - Wyszukaj informacje o usłudze
router.post('/service-info', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { serviceName, location } = req.body;
    
    if (!serviceName || serviceName.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Service name must be at least 2 characters long'
      });
    }

    console.log('🔍 Searching service info:', { serviceName, location });

    const results = await webSearchService.searchServiceInfo(serviceName, location);

    res.json({
      success: true,
      serviceName,
      location,
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Service info search error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/web-search/compare - Porównanie dostawców wyszukiwania
router.post('/compare', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { query, lang = 'pl' } = req.body;
    
    if (!query || query.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Query must be at least 3 characters long'
      });
    }

    console.log('🔄 Comparing web search providers:', { query, lang });

    const results = {
      bing: null,
      serpapi: null,
      perplexity: null,
      comparison: null
    };

    // Test każdego dostawcy
    const providers = ['bing', 'serpapi', 'perplexity'];
    
    for (const provider of providers) {
      try {
        const result = await webSearchService.search(query, {
          provider,
          lang,
          count: 3
        });
        results[provider] = {
          success: true,
          result,
          provider
        };
      } catch (error) {
        results[provider] = {
          success: false,
          error: error.message,
          provider
        };
      }
    }

    // Porównanie wyników
    const successfulResults = Object.values(results).filter(r => r.success);
    if (successfulResults.length > 1) {
      results.comparison = {
        totalProviders: successfulResults.length,
        resultCounts: successfulResults.map(r => ({
          provider: r.provider,
          count: r.result.results.length,
          totalResults: r.result.totalResults
        })),
        uniqueUrls: this.getUniqueUrls(successfulResults)
      };
    }

    res.json({
      success: true,
      query,
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Web search compare error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/web-search/config - Konfiguracja dostawców wyszukiwania
router.post('/config', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { defaultProvider, fallbackEnabled } = req.body;
    
    // Walidacja
    if (defaultProvider && !['bing', 'serpapi', 'perplexity'].includes(defaultProvider)) {
      return res.status(400).json({
        success: false,
        error: 'Nieprawidłowy dostawca. Dozwolone: bing, serpapi, perplexity'
      });
    }

    // Aktualizuj konfigurację (w prawdziwej aplikacji zapisz to w bazie danych)
    if (defaultProvider) {
      process.env.WEB_SEARCH_PROVIDER = defaultProvider;
    }
    if (fallbackEnabled !== undefined) {
      process.env.WEB_SEARCH_FALLBACK_ENABLED = fallbackEnabled.toString();
    }

    const newStatus = webSearchService.getStatus();
    
    res.json({
      success: true,
      message: 'Konfiguracja wyszukiwania internetowego zaktualizowana',
      status: newStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Web search config error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper function to get unique URLs from search results
function getUniqueUrls(successfulResults) {
  const allUrls = new Set();
  successfulResults.forEach(result => {
    result.result.results.forEach(item => {
      allUrls.add(item.url);
    });
  });
  return Array.from(allUrls);
}

module.exports = router;
