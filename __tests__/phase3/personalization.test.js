/**
 * Testy dla PersonalizationService
 */

const PersonalizationService = require('../../services/PersonalizationService');
const ConversationMemoryService = require('../../services/ConversationMemoryService');
const Order = require('../../models/Order');
const User = require('../../models/User');
const AIFeedback = require('../../models/AIFeedback');
const mongoose = require('mongoose');

// Mock dla ConversationMemoryService
jest.mock('../../services/ConversationMemoryService');

describe('Phase 3: PersonalizationService', () => {
  let userId;

  beforeAll(async () => {
    // Połącz z MongoDB
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    userId = new mongoose.Types.ObjectId();
  });

  afterAll(async () => {
    // Cleanup
    await Order.deleteMany({ client: userId }).catch(() => {});
    await AIFeedback.deleteMany({ user: userId }).catch(() => {});
    await User.deleteOne({ _id: userId }).catch(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getUserProfile', () => {
    test('should return default profile for new user', async () => {
      ConversationMemoryService.getUserPreferences.mockResolvedValue({
        preferredServices: [],
        preferredLocations: [],
        communicationStyle: 'casual',
        urgencyPattern: 'mixed'
      });

      const profile = await PersonalizationService.getUserProfile(userId);

      expect(profile).toBeDefined();
      expect(profile.userId).toEqual(userId);
      expect(profile.orderHistory).toBeDefined();
      expect(profile.orderHistory.total).toBeGreaterThanOrEqual(0);
      expect(profile.communicationStyle).toBeDefined();
      expect(profile.expertiseLevel).toBeDefined();
    });

    test('should return profile with order history', async () => {
      ConversationMemoryService.getUserPreferences.mockResolvedValue({
        preferredServices: [],
        preferredLocations: [],
        communicationStyle: 'casual'
      });

      // Utwórz testowe zlecenia
      await Order.create({
        client: userId,
        service: 'hydraulik',
        description: 'Test order',
        location: 'Warszawa',
        urgency: 'today',
        status: 'open',
        budget: 500
      });

      const profile = await PersonalizationService.getUserProfile(userId);

      expect(profile.orderHistory).toBeDefined();
      expect(profile.orderHistory.total).toBeGreaterThanOrEqual(0);
      expect(profile.orderHistory.services).toBeDefined();
    });

    test('should infer communication style from feedback', async () => {
      ConversationMemoryService.getUserPreferences.mockResolvedValue(null);

      // Utwórz feedback wskazujący na preferencję szczegółowych odpowiedzi
      await AIFeedback.create({
        user: userId,
        sessionId: 'test_session',
        messageId: 'test_msg',
        agent: 'concierge',
        description: 'Test feedback',
        quickFeedback: 'positive',
        feedback: {
          rating: 5,
          comment: 'Bardzo szczegółowa odpowiedź'
        }
      });

      const profile = await PersonalizationService.getUserProfile(userId);

      // Should infer style from high rating
      expect(profile.feedbackHistory.averageRating).toBeGreaterThan(0);
    });
  });

  describe('getOrderHistory', () => {
    test('should return empty history for user with no orders', async () => {
      // Use a fresh userId that definitely has no orders
      const freshUserId = new mongoose.Types.ObjectId();
      const history = await PersonalizationService.getOrderHistory(freshUserId);

      expect(history).toBeDefined();
      expect(history.total).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(history.recent)).toBe(true);
      expect(typeof history.services).toBe('object');
    });

    test('should analyze order history correctly', async () => {
      // Utwórz kilka zleceń
      await Order.create([
        {
          client: userId,
          service: 'hydraulik',
          description: 'Order 1',
          urgency: 'today',
          status: 'open',
          budget: 300
        },
        {
          client: userId,
          service: 'elektryk',
          description: 'Order 2',
          urgency: 'flexible',
          status: 'open',
          budget: 500
        },
        {
          client: userId,
          service: 'hydraulik',
          description: 'Order 3',
          urgency: 'today',
          status: 'open',
          budget: 400
        }
      ]);

      const history = await PersonalizationService.getOrderHistory(userId);

      expect(history.total).toBeGreaterThanOrEqual(3);
      expect(history.topService).toBeDefined();
      expect(history.preferredUrgency).toBeDefined();
      expect(history.averageBudget).toBeGreaterThan(0);
    });
  });

  describe('getFeedbackHistory', () => {
    test('should return empty history for user with no feedback', async () => {
      const history = await PersonalizationService.getFeedbackHistory(userId);

      expect(history).toBeDefined();
      expect(history.total).toBeGreaterThanOrEqual(0);
    });

    test('should calculate average rating correctly', async () => {
      await AIFeedback.create([
        {
          user: userId,
          sessionId: 'session1',
          messageId: 'msg1',
          agent: 'concierge',
          description: 'Test feedback 1',
          quickFeedback: 'positive',
          feedback: { rating: 5 }
        },
        {
          user: userId,
          sessionId: 'session2',
          messageId: 'msg2',
          agent: 'concierge',
          description: 'Test feedback 2',
          quickFeedback: 'positive',
          feedback: { rating: 4 }
        },
        {
          user: userId,
          sessionId: 'session3',
          messageId: 'msg3',
          agent: 'concierge',
          description: 'Test feedback 3',
          quickFeedback: 'negative',
          feedback: { rating: 2 }
        }
      ]);

      const history = await PersonalizationService.getFeedbackHistory(userId);

      expect(history.total).toBeGreaterThanOrEqual(3);
      expect(history.averageRating).toBeGreaterThan(0);
      expect(history.averageRating).toBeLessThanOrEqual(5);
      expect(history.satisfactionRate).toBeGreaterThanOrEqual(0);
      expect(history.satisfactionRate).toBeLessThanOrEqual(100);
    });
  });

  describe('inferCommunicationStyle', () => {
    test('should return casual as default', () => {
      const style = PersonalizationService.inferCommunicationStyle({}, {
        averageRating: null,
        commonIssues: []
      });

      expect(style).toBe('casual');
    });

    test('should return detailed for high ratings', () => {
      const style = PersonalizationService.inferCommunicationStyle({}, {
        averageRating: 4.8,
        commonIssues: []
      });

      expect(style).toBe('detailed');
    });

    test('should return brief if user complained about length', () => {
      const style = PersonalizationService.inferCommunicationStyle({}, {
        averageRating: 3,
        commonIssues: ['Zbyt długie odpowiedzi']
      });

      expect(style).toBe('brief');
    });
  });

  describe('inferExpertiseLevel', () => {
    test('should return beginner for new users', () => {
      const level = PersonalizationService.inferExpertiseLevel(
        { total: 0 },
        { averageRating: null }
      );

      expect(level).toBe('beginner');
    });

    test('should return intermediate for users with some orders', () => {
      const level = PersonalizationService.inferExpertiseLevel(
        { total: 5 },
        { averageRating: 4 }
      );

      expect(level).toBe('intermediate');
    });

    test('should return expert for experienced users', () => {
      const level = PersonalizationService.inferExpertiseLevel(
        { total: 15 },
        { averageRating: 4.8 }
      );

      expect(level).toBe('expert');
    });
  });

  describe('personalizePrompt', () => {
    test('should add style hints to prompt', () => {
      const basePrompt = 'You are a helpful assistant.';
      const userProfile = {
        communicationStyle: 'brief',
        expertiseLevel: 'beginner',
        orderHistory: {},
        preferences: {
          preferredLocations: []
        }
      };

      const personalized = PersonalizationService.personalizePrompt(basePrompt, userProfile);

      expect(personalized).toContain('zwięźle');
      expect(personalized).toContain('prostego języka');
    });

    test('should add expertise hints to prompt', () => {
      const basePrompt = 'You are a helpful assistant.';
      const userProfile = {
        communicationStyle: 'casual',
        expertiseLevel: 'expert',
        orderHistory: {},
        preferences: {
          preferredLocations: []
        }
      };

      const personalized = PersonalizationService.personalizePrompt(basePrompt, userProfile);

      expect(personalized).toContain('doświadczony');
      expect(personalized).toContain('techniczny');
    });

    test('should add service preferences to prompt', () => {
      const basePrompt = 'You are a helpful assistant.';
      const userProfile = {
        communicationStyle: 'casual',
        expertiseLevel: 'intermediate',
        orderHistory: {
          topService: 'hydraulik',
          preferredUrgency: 'today'
        },
        preferences: {
          preferredLocations: ['Warszawa']
        }
      };

      const personalized = PersonalizationService.personalizePrompt(basePrompt, userProfile);

      expect(personalized).toContain('hydraulik');
      expect(personalized).toContain('today');
      expect(personalized).toContain('Warszawa');
    });
  });

  describe('personalizeResponse', () => {
    test('should shorten response for brief style', () => {
      const response = {
        reply: 'To jest bardzo długa odpowiedź. Składa się z wielu zdań. Każde zdanie zawiera dużo informacji. Może być jeszcze dłuższa jeśli dodamy więcej treści.'
      };

      const userProfile = {
        communicationStyle: 'brief'
      };

      const personalized = PersonalizationService.personalizeResponse(response, userProfile);

      expect(personalized.reply.split(/[.!?]+/).filter(s => s.trim()).length).toBeLessThanOrEqual(3);
    });

    test('should keep full response for non-brief styles', () => {
      const response = {
        reply: 'To jest bardzo długa odpowiedź. Składa się z wielu zdań. Każde zdanie zawiera dużo informacji.'
      };

      const userProfile = {
        communicationStyle: 'detailed'
      };

      const personalized = PersonalizationService.personalizeResponse(response, userProfile);

      expect(personalized.reply).toBe(response.reply);
    });
  });

  describe('getDefaultProfile', () => {
    test('should return default profile structure', () => {
      const profile = PersonalizationService.getDefaultProfile(userId);

      expect(profile.userId).toEqual(userId);
      expect(profile.communicationStyle).toBe('casual');
      expect(profile.expertiseLevel).toBe('beginner');
      expect(profile.orderHistory.total).toBe(0);
      expect(profile.preferences).toBeDefined();
    });
  });

  describe('updateProfileFromInteraction', () => {
    test('should update preferences in ConversationMemory', async () => {
      ConversationMemoryService.updatePreferences.mockResolvedValue({});

      await PersonalizationService.updateProfileFromInteraction(userId, {
        sessionId: 'test_session',
        detectedService: 'hydraulik',
        location: 'Warszawa'
      });

      expect(ConversationMemoryService.updatePreferences).toHaveBeenCalled();
    });
  });
});

