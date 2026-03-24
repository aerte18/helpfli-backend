/**
 * Tool: webSearch
 * Wyszukuje informacje w internecie dla rzadkich lub niszowych problemów
 */

// WebSearchService może nie być dostępny - użyj fallback
let webSearchService = null;
try {
  webSearchService = require('../../services/webSearchService');
} catch (e) {
  // Service nie istnieje - to OK, zwrócimy info
}

async function webSearchTool(params, context) {
  try {
    const { query, maxResults = 5 } = params;

    if (!query) {
      throw new Error('Query is required');
    }

    // Użyj webSearchService jeśli dostępny
    if (!webSearchService || typeof webSearchService.search !== 'function') {
      // Fallback: zwróć informację że wyszukiwanie nie jest dostępne
      return {
        success: false,
        message: 'Web search is not available',
        results: []
      };
    }

    // Wykonaj wyszukiwanie
    const results = await webSearchService.search(query, maxResults);

    return {
      success: true,
      query,
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet || r.description,
        date: r.date || null
      })),
      count: results.length,
      message: `Znaleziono ${results.length} wyników dla zapytania "${query}"`
    };

  } catch (error) {
    console.error('webSearchTool error:', error);
    // Nie rzucaj błędu - zwróć pusty wynik
    return {
      success: false,
      error: error.message,
      results: [],
      message: 'Wyszukiwanie internetowe nie jest dostępne'
    };
  }
}

module.exports = webSearchTool;

