/**
 * Testy integracyjne dla Fazy 3
 */

const PersonalizationService = require('../../services/PersonalizationService');
const WebSearchIntegrationService = require('../../services/WebSearchIntegrationService');
const abTestingService = require('../../services/ABTestingService');
const ConversationMemoryService = require('../../services/ConversationMemoryService');
const mongoose = require('mongoose');

// Mock dla ConversationMemoryService
jest.mock('../../services/ConversationMemoryService');
jest.mock('../../ai/tools/webSearchTool');

describe('Phase 3: Integration Tests', () => {
  let userId;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    userId = new mongoose.Types.ObjectId();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ConversationMemoryService.getUserPreferences.mockResolvedValue({
      preferredServices: [],
      preferredLocations: [],
      communicationStyle: 'casual'
    });
  });

  describe('Personalization + A/B Testing Integration', () => {
    test('should personalize prompt with A/B testing variant', () => {
      const basePrompt = 'You are a helpful assistant.';
      
      // Assign A/B variant
      const variant = abTestingService.assignVariant(userId, 'response_length');
      const variantConfig = abTestingService.getVariantConfig('response_length', variant);
      
      // Get user profile
      const userProfile = PersonalizationService.getDefaultProfile(userId);
      userProfile.communicationStyle = 'brief';
      
      // Personalize prompt
      let personalized = PersonalizationService.personalizePrompt(basePrompt, userProfile);
      
      // Should contain personalization hints
      expect(personalized).toContain('zwięźle');
      
      // Should be able to use A/B variant config
      expect(variantConfig).toBeDefined();
    });
  });

  describe('Web Search + Personalization Integration', () => {
    test('should decide when to search based on user message and profile', () => {
      const userMessage = 'Nie jestem pewien co to może być - bardzo rzadki problem';
      const detectedService = 'inne';
      const confidence = 0.5;
      
      const shouldSearch = WebSearchIntegrationService.shouldSearchWeb(
        userMessage,
        detectedService,
        confidence
      );
      
      expect(shouldSearch).toBe(true);
    });

    test('should not search for confident standard requests', () => {
      const userMessage = 'Potrzebuję hydraulika do naprawy wycieku';
      const detectedService = 'hydraulik';
      const confidence = 0.9;
      
      const shouldSearch = WebSearchIntegrationService.shouldSearchWeb(
        userMessage,
        detectedService,
        confidence
      );
      
      expect(shouldSearch).toBe(false);
    });
  });

  describe('Full Flow Integration', () => {
    test('should handle complete personalization flow', async () => {
      // 1. Get user profile
      const profile = await PersonalizationService.getUserProfile(userId);
      expect(profile).toBeDefined();
      
      // 2. Get A/B variant
      const variant = abTestingService.assignVariant(userId, 'response_length');
      expect(['A', 'B', 'C']).toContain(variant);
      
      // 3. Personalize prompt
      const basePrompt = 'You are a helpful assistant.';
      const personalized = PersonalizationService.personalizePrompt(basePrompt, profile);
      expect(personalized.length).toBeGreaterThan(basePrompt.length);
      
      // 4. Personalize response
      const response = {
        reply: 'To jest bardzo długa odpowiedź. Składa się z wielu zdań. Każde zdanie zawiera dużo informacji.'
      };
      const personalizedResponse = PersonalizationService.personalizeResponse(response, profile);
      expect(personalizedResponse.reply).toBeDefined();
    });
  });
});

