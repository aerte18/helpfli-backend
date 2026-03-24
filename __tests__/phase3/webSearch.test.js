/**
 * Testy dla WebSearchIntegrationService
 */

const WebSearchIntegrationService = require('../../services/WebSearchIntegrationService');
const webSearchTool = require('../../ai/tools/webSearchTool');

// Mock dla webSearchTool
jest.mock('../../ai/tools/webSearchTool');

describe('Phase 3: WebSearchIntegrationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('shouldSearchWeb', () => {
    test('should return true for low confidence', () => {
      const result = WebSearchIntegrationService.shouldSearchWeb(
        'Nie jestem pewien co to może być',
        'inne',
        0.5
      );

      expect(result).toBe(true);
    });

    test('should return true for rare keywords', () => {
      const result = WebSearchIntegrationService.shouldSearchWeb(
        'To jest bardzo rzadki problem, nigdy nie widziałem czegoś takiego',
        'hydraulik',
        0.8
      );

      expect(result).toBe(true);
    });

    test('should return true for "inne" service with long message', () => {
      const result = WebSearchIntegrationService.shouldSearchWeb(
        'Mam problem z bardzo specyficzną rzeczą która nie pasuje do żadnej kategorii',
        'inne',
        0.9
      );

      expect(result).toBe(true);
    });

    test('should return false for high confidence standard message', () => {
      const result = WebSearchIntegrationService.shouldSearchWeb(
        'Potrzebuję hydraulika',
        'hydraulik',
        0.9
      );

      expect(result).toBe(false);
    });
  });

  describe('searchForProblem', () => {
    test('should return empty results if webSearchTool not available', async () => {
      mockWebSearchTool.mockResolvedValue({
        success: false,
        message: 'Web search is not available',
        results: []
      });

      const result = await WebSearchIntegrationService.searchForProblem(
        'Test problem',
        'hydraulik'
      );

      expect(result.success).toBe(false);

      const result = await WebSearchIntegrationService.searchForProblem(
        'Test problem',
        'hydraulik'
      );

      expect(result.success).toBe(false);
      expect(result.results).toEqual([]);
    });

    test('should search and return results', async () => {
      mockWebSearchTool.mockResolvedValue({
        success: true,
        query: 'hydraulik Test problem',
        results: [
          {
            title: 'Test Result 1',
            url: 'https://example.com/1',
            snippet: 'This is a test snippet 1',
            date: '2025-01-01'
          },
          {
            title: 'Test Result 2',
            url: 'https://example.com/2',
            snippet: 'This is a test snippet 2'
          }
        ],
        count: 2,
        message: 'Znaleziono 2 wyników'
      });

      const result = await WebSearchIntegrationService.searchForProblem(
        'Test problem',
        'hydraulik'
      );

      expect(result.success).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].relevance).toBeDefined();
    });

    test('should calculate relevance correctly', async () => {
      mockWebSearchTool.mockResolvedValue({
        success: true,
        query: 'test',
        results: [
          {
            title: 'Test Result with matching words',
            url: 'https://example.pl/1',
            snippet: 'This is a test snippet with matching words',
            date: '2025-01-01'
          }
        ],
        count: 1
      });

      const result = await WebSearchIntegrationService.searchForProblem(
        'test problem with matching words',
        null
      );

      expect(result.success).toBe(true);
      expect(result.results[0].relevance).toBeGreaterThan(0.5);
    });

    test('should prioritize Polish sources', async () => {
      mockWebSearchTool.mockResolvedValue({
        success: true,
        query: 'test',
        results: [
          {
            title: 'Polish Result',
            url: 'https://example.pl/1',
            snippet: 'Test snippet'
          },
          {
            title: 'English Result',
            url: 'https://example.com/1',
            snippet: 'Test snippet'
          }
        ],
        count: 2
      });

      const result = await WebSearchIntegrationService.searchForProblem(
        'test',
        null
      );

      // Polish result should have higher relevance
      const polishResult = result.results.find(r => r.url.includes('.pl'));
      const englishResult = result.results.find(r => !r.url.includes('.pl'));

      if (polishResult && englishResult) {
        expect(polishResult.relevance).toBeGreaterThan(englishResult.relevance);
      }
    });
  });

  describe('enrichResponseWithSearch', () => {
    test('should add search results to response', () => {
      const aiResponse = {
        reply: 'Oto odpowiedź AI.'
      };

      const searchResults = {
        success: true,
        results: [
          {
            title: 'Result 1',
            snippet: 'Snippet 1'
          },
          {
            title: 'Result 2',
            snippet: 'Snippet 2'
          }
        ]
      };

      const enriched = WebSearchIntegrationService.enrichResponseWithSearch(
        aiResponse,
        searchResults
      );

      expect(enriched.reply).toContain('Znalazłem dodatkowe informacje');
      expect(enriched.reply).toContain('Result 1');
      expect(enriched.webSearch).toBeDefined();
      expect(enriched.webSearch.performed).toBe(true);
    });

    test('should not modify response if search failed', () => {
      const aiResponse = {
        reply: 'Oto odpowiedź AI.'
      };

      const searchResults = {
        success: false,
        results: []
      };

      const enriched = WebSearchIntegrationService.enrichResponseWithSearch(
        aiResponse,
        searchResults
      );

      expect(enriched.reply).toBe(aiResponse.reply);
      expect(enriched.webSearch).toBeUndefined();
    });
  });
});

