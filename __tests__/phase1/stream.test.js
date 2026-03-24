/**
 * Testy dla Streaming Responses (Faza 1)
 * 
 * Uwaga: Te testy wymagają prawdziwego połączenia z Claude API
 * Dla pełnych testów potrzebny jest ANTHROPIC_API_KEY
 */

const { streamLLM } = require('../../ai/utils/llmAdapter');

describe('Phase 1: Streaming Responses', () => {
  // Sprawdź czy API key jest dostępny
  const hasApiKey = process.env.ANTHROPIC_API_KEY && 
                   process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-');

  describe('streamLLM', () => {
    (hasApiKey ? test : test.skip)('should stream response from Claude', async () => {
      const systemPrompt = 'Jesteś pomocnym asystentem.';
      const messages = [
        { role: 'user', content: 'Powiedz krótko: "Test streamingu"' }
      ];

      const chunks = [];
      const result = await streamLLM(
        systemPrompt,
        messages,
        (chunk) => {
          chunks.push(chunk);
        }
      );

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe('string');
      expect(chunks.length).toBeGreaterThan(0);
      expect(result.finishReason).toBe('stop');
    }, 30000); // 30s timeout

    (hasApiKey ? test : test.skip)('should handle errors gracefully', async () => {
      const systemPrompt = 'Jesteś pomocnym asystentem.';
      const messages = [
        { role: 'user', content: 'Test' }
      ];

      // Test z nieprawidłowym promptem (pusty)
      await expect(
        streamLLM('', messages, () => {})
      ).rejects.toThrow();
    }, 10000);
  });

  // Test struktury bez prawdziwego API call
  test('should have streamLLM function', () => {
    expect(typeof streamLLM).toBe('function');
  });
});

