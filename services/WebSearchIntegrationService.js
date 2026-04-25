/**
 * WebSearchIntegrationService
 * Automatyczne wyszukiwanie w internecie dla rzadkich problemów
 */

class WebSearchIntegrationService {
  /**
   * Sprawdź czy problem wymaga wyszukiwania w internecie
   */
  static shouldSearchWeb(userMessage, detectedService, confidence) {
    // Wyszukuj jeśli:
    // 1. Niska pewność wykrycia usługi
    // 2. Rzadkie słowa kluczowe
    // 3. Użytkownik pyta o coś specyficznego

    const rareKeywords = [
      'rzadk', 'unikaln', 'specyficzn', 'nietypow',
      'nie wiem', 'nie jestem pewien', 'co to może być',
      'nigdy nie widziałem', 'pierwszy raz'
    ];

    const messageLower = userMessage.toLowerCase();
    const hasRareKeyword = rareKeywords.some(keyword => messageLower.includes(keyword));

    // Niska pewność (< 0.6) lub rzadkie słowa
    if (confidence < 0.6 || hasRareKeyword) {
      return true;
    }

    // Jeśli usługa to 'inne' i użytkownik pyta o coś konkretnego
    if (detectedService === 'inne' && userMessage.length > 20) {
      return true;
    }

    return false;
  }

  /**
   * Wykonaj wyszukiwanie i zwróć wyniki
   */
  static async searchForProblem(problemDescription, detectedService = null) {
    try {
      // Sprawdź czy webSearchTool jest dostępny
      let webSearchTool = null;
      try {
        webSearchTool = require('../ai/tools/webSearchTool');
      } catch (err) {
        // webSearchTool nie jest dostępny
      }

      if (!webSearchTool || typeof webSearchTool !== 'function') {
        return {
          success: false,
          results: [],
          message: 'Web search is not available'
        };
      }

      // Przygotuj query
      let query = problemDescription;
      
      if (detectedService && detectedService !== 'inne') {
        query = `${detectedService} ${problemDescription}`;
      }

      // Wykonaj wyszukiwanie używając webSearchTool
      const toolResult = await webSearchTool({
        query: query,
        maxResults: 5
      }, { userId: null });

      // webSearchTool zwraca { success, results, query, count, message }
      if (!toolResult.success || !toolResult.results) {
        return {
          success: false,
          results: [],
          message: toolResult.message || 'Nie znaleziono wyników'
        };
      }

      const results = toolResult.results || [];

      if (!results || results.length === 0) {
        return {
          success: false,
          results: [],
          message: 'Nie znaleziono wyników'
        };
      }

      // Przetworz wyniki
      const processedResults = results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet || r.description || '',
        relevance: this.calculateRelevance(r, problemDescription)
      })).sort((a, b) => b.relevance - a.relevance); // Sortuj po relevancji

      return {
        success: true,
        results: processedResults.slice(0, 3), // Top 3
        query,
        message: `Znaleziono ${processedResults.length} wyników w internecie`
      };

    } catch (error) {
      console.error('Error in web search:', error);
      return {
        success: false,
        results: [],
        error: error.message
      };
    }
  }

  /**
   * Oblicz relevancję wyniku wyszukiwania
   */
  static calculateRelevance(result, problemDescription) {
    let score = 0.5; // Base score

    const text = `${result.title} ${result.snippet}`.toLowerCase();
    const problemLower = problemDescription.toLowerCase();

    // Sprawdź wspólne słowa
    const problemWords = problemLower.split(/\s+/).filter(w => w.length > 3);
    const matchingWords = problemWords.filter(word => text.includes(word));
    score += (matchingWords.length / problemWords.length) * 0.3;

    // Bonus za polskie źródła
    if (result.url && (result.url.includes('.pl') || result.url.includes('polsk'))) {
      score += 0.1;
    }

    // Bonus za świeże wyniki (jeśli data dostępna)
    if (result.date) {
      const resultDate = new Date(result.date);
      const daysOld = (Date.now() - resultDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld < 365) {
        score += 0.1;
      }
    }

    return Math.min(score, 1.0);
  }

  /**
   * Wzbogać odpowiedź AI o wyniki wyszukiwania
   */
  static enrichResponseWithSearch(aiResponse, searchResults) {
    if (!searchResults.success || searchResults.results.length === 0) {
      return aiResponse;
    }

    // Dodaj informacje z wyszukiwania do odpowiedzi
    const searchInfo = searchResults.results
      .slice(0, 2)
      .map(r => `📄 ${r.title}: ${r.snippet.substring(0, 100)}...`)
      .join('\n');

    if (aiResponse.reply) {
      aiResponse.reply += `\n\n🔍 Znalazłem dodatkowe informacje w internecie:\n${searchInfo}`;
    }

    // Dodaj metadata
    aiResponse.webSearch = {
      performed: true,
      resultsCount: searchResults.results.length,
      query: searchResults.query
    };

    return aiResponse;
  }
}

module.exports = WebSearchIntegrationService;

