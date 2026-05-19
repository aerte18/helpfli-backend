const {
  getRoutingMode,
  shouldUseSmartModel,
  shouldEnableConciergeTools,
  isGoodEnough
} = require('../../services/aiRouter');

describe('aiRouter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getRoutingMode', () => {
    it('respects AI_ROUTER_MODE=hybrid', () => {
      process.env.AI_ROUTER_MODE = 'hybrid';
      process.env.GEMINI_API_KEY = 'test-gemini-key-12345';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key-1234567890';
      expect(getRoutingMode()).toBe('hybrid');
    });

    it('falls back to claude without gemini key', () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.AI_ROUTER_MODE;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key-1234567890';
      expect(getRoutingMode()).toBe('claude');
    });
  });

  describe('shouldEnableConciergeTools', () => {
    it('enables tools when user mentions order actions', () => {
      const messages = [{ role: 'user', content: 'Pokaż moje zlecenia' }];
      expect(shouldEnableConciergeTools(messages, {})).toBe(true);
    });

    it('disables tools for simple problem description', () => {
      const messages = [{ role: 'user', content: 'Cieknie mi kran w kuchni' }];
      expect(shouldEnableConciergeTools(messages, {})).toBe(false);
    });
  });

  describe('shouldUseSmartModel', () => {
    it('uses smart model for danger keywords', () => {
      const messages = [{ role: 'user', content: 'Czuję zapach gazu w kuchni' }];
      expect(shouldUseSmartModel({ messages, agentType: 'concierge' })).toBe(true);
    });

    it('uses smart model for diagnostic agent', () => {
      const messages = [{ role: 'user', content: 'Krótki opis' }];
      expect(shouldUseSmartModel({ messages, agentType: 'diagnostic' })).toBe(true);
    });
  });

  describe('isGoodEnough', () => {
    it('rejects short or uncertain concierge replies', () => {
      expect(isGoodEnough({ reply: 'ok', detectedService: 'inne' }, 'concierge')).toBe(false);
      expect(
        isGoodEnough(
          { reply: 'Nie wiem jak pomóc', detectedService: 'inne', confidence: 0.9 },
          'concierge'
        )
      ).toBe(false);
    });

    it('accepts solid concierge JSON', () => {
      expect(
        isGoodEnough(
          {
            reply: 'Wygląda na problem z hydrauliką — opisz proszę gdzie dokładnie cieknie woda.',
            detectedService: 'hydraulik_naprawa',
            intent: 'service_request',
            confidence: 0.85
          },
          'concierge'
        )
      ).toBe(true);
    });
  });
});
