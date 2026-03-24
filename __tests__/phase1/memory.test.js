?/**
 * Testy dla Memory & Context Management (Faza 1)
 */

const ConversationMemoryService = require('../../services/ConversationMemoryService');
const ConversationMemory = require('../../models/ConversationMemory');
const mongoose = require('mongoose');

describe('Phase 1: Memory & Context Management', () => {
  let userId;
  let sessionId;

  beforeAll(async () => {
    // Połącz z MongoDB (test database)
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    
    userId = new mongoose.Types.ObjectId();
    sessionId = `test_session_${Date.now()}`;
  });

  afterAll(async () => {
    // Wyczyść test data
    await ConversationMemory.deleteMany({ userId, sessionId });
    await mongoose.connection.close();
  });

  describe('ConversationMemoryService', () => {
    test('should create a new session', async () => {
      const memory = await ConversationMemoryService.getOrCreateSession(
        userId,
        sessionId,
        'concierge'
      );

      expect(memory).toBeDefined();
      expect(memory.userId.toString()).toBe(userId.toString());
      expect(memory.sessionId).toBe(sessionId);
      expect(memory.agentType).toBe('concierge');
    });

    test('should add messages to session', async () => {
      await ConversationMemoryService.addMessage(
        userId,
        sessionId,
        'user',
        'Witaj, mam problem z hydrauliką',
        'concierge',
        {},
        'concierge'
      );

      await ConversationMemoryService.addMessage(
        userId,
        sessionId,
        'assistant',
        'Rozumiem, pomogę Ci znaleźć hydraulika',
        'concierge',
        { detectedService: 'hydraulik' },
        'concierge'
      );

      const context = await ConversationMemoryService.getContext(
        userId,
        sessionId,
        10,
        'concierge'
      );

      expect(context.recentMessages).toHaveLength(2);
      expect(context.recentMessages[0].role).toBe('user');
      expect(context.recentMessages[0].content).toContain('hydrauliką');
      expect(context.recentMessages[1].role).toBe('assistant');
    });

    test('should get context with recent messages', async () => {
      const context = await ConversationMemoryService.getContext(
        userId,
        sessionId,
        10,
        'concierge'
      );

      expect(context).toBeDefined();
      expect(context.recentMessages).toBeDefined();
      expect(Array.isArray(context.recentMessages)).toBe(true);
      expect(context.preferences).toBeDefined();
    });

    test('should update preferences', async () => {
      await ConversationMemoryService.updatePreferences(
        userId,
        sessionId,
        {
          preferredServices: ['hydraulik'],
          preferredLocations: ['Warszawa'],
          communicationStyle: 'casual'
        },
        'concierge'
      );

      const context = await ConversationMemoryService.getContext(
        userId,
        sessionId,
        10,
        'concierge'
      );

      expect(context.preferences.preferredServices).toContain('hydraulik');
      expect(context.preferences.preferredLocations).toContain('Warszawa');
      expect(context.preferences.communicationStyle).toBe('casual');
    });

    test('should update last interaction', async () => {
      await ConversationMemoryService.updateLastInteraction(
        userId,
        sessionId,
        {
          detectedService: 'hydraulik',
          urgency: 'urgent',
          location: 'Warszawa',
          nextStep: 'suggest_providers'
        },
        'concierge'
      );

      const memory = await ConversationMemory.findOne({ userId, sessionId });
      expect(memory.lastInteraction).toBeDefined();
      expect(memory.lastInteraction.detectedService).toBe('hydraulik');
      expect(memory.lastInteraction.urgency).toBe('urgent');
    });

    test('should get user preferences from all sessions', async () => {
      const preferences = await ConversationMemoryService.getUserPreferences(userId, 'concierge');
      
      expect(preferences).toBeDefined();
      expect(preferences.preferredServices).toBeDefined();
      expect(preferences.preferredLocations).toBeDefined();
      expect(preferences.communicationStyle).toBeDefined();
    });
  });
});

