/**
 * ConversationMemoryService
 * Zarządza pamięcią konwersacji i kontekstem dla AI agentów
 */

const ConversationMemory = require('../models/ConversationMemory');
const { callLLMWithJSONFormat } = require('../ai/utils/llmAdapter');

class ConversationMemoryService {
  /**
   * Pobierz lub utwórz sesję pamięci
   */
  static async getOrCreateSession(userId, sessionId, agentType = 'concierge') {
    try {
      return await ConversationMemory.findOrCreateSession(userId, sessionId, agentType);
    } catch (error) {
      console.error('Error getting/creating session:', error);
      throw error;
    }
  }

  /**
   * Dodaj wiadomość do sesji
   */
  static async addMessage(userId, sessionId, role, content, agent = 'concierge', metadata = {}, agentType = 'concierge') {
    try {
      const memory = await ConversationMemory.findOrCreateSession(userId, sessionId, agentType);
      memory.addMessage(role, content, agent, metadata);
      
      // Jeśli przekroczono limit, uruchom kompresję asynchronicznie
      if (memory.messages.length > 50 && !memory.summary) {
        // Uruchom kompresję w tle (nie czekaj)
        this.compressOldMessages(userId, sessionId, agentType).catch(err => {
          console.error('Background compression failed:', err);
        });
      }
      
      await memory.save();
      return memory;
    } catch (error) {
      console.error('Error adding message:', error);
      throw error;
    }
  }

  /**
   * Pobierz kontekst dla agenta (ostatnie N wiadomości + summary)
   */
  static async getContext(userId, sessionId, limit = 10, agentType = 'concierge') {
    try {
      const memory = await ConversationMemory.findOne({ userId, sessionId, agentType });
      
      if (!memory) {
        return {
          summary: null,
          summaryMessageCount: 0,
          recentMessages: [],
          preferences: {
            preferredServices: [],
            preferredLocations: [],
            communicationStyle: 'casual',
            urgencyPattern: 'mixed'
          },
          lastInteraction: null
        };
      }
      
      return memory.getContext(limit);
    } catch (error) {
      console.error('Error getting context:', error);
      return {
        summary: null,
        summaryMessageCount: 0,
        recentMessages: [],
        preferences: {},
        lastInteraction: null
      };
    }
  }

  /**
   * Pobierz historię użytkownika (ostatnie sesje)
   */
  static async getUserHistory(userId, limit = 5, agentType = 'concierge') {
    try {
      const memories = await ConversationMemory.find({ userId, agentType })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select('sessionId updatedAt lastInteraction stats.preferences')
        .lean();
      
      return memories.map(m => ({
        sessionId: m.sessionId,
        updatedAt: m.updatedAt,
        lastInteraction: m.lastInteraction,
        preferences: m.preferences || {},
        stats: m.stats || {}
      }));
    } catch (error) {
      console.error('Error getting user history:', error);
      return [];
    }
  }

  /**
   * Kompresuj stare wiadomości (tworzenie summary)
   */
  static async compressOldMessages(userId, sessionId, agentType = 'concierge') {
    try {
      const memory = await ConversationMemory.findOne({ userId, sessionId, agentType });
      
      if (!memory || memory.messages.length <= 50) {
        return;
      }
      
      // Znajdź wiadomości do skompresowania
      const messagesToCompress = memory.messages
        .filter(m => !m.isSummarized)
        .slice(0, memory.messages.length - 50);
      
      if (messagesToCompress.length === 0) {
        return;
      }
      
      // Stwórz summary używając LLM
      const messagesText = messagesToCompress
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');
      
      const summaryPrompt = `Podsumuj następującą konwersację użytkownika z AI asystentem. 
      Wyekstraktuj kluczowe informacje: problemy, rozwiązania, preferencje, lokalizacje, usługi.

Konwersacja:
${messagesText}

Stwórz zwięzłe podsumowanie (max 300 słów) które zachowa kontekst dla dalszych rozmów.`;
      
      try {
        const summaryResponse = await callLLMWithJSONFormat(
          summaryPrompt,
          [{ role: 'user', content: messagesText }]
        );
        
        const summary = typeof summaryResponse === 'string' 
          ? summaryResponse 
          : summaryResponse.summary || JSON.stringify(summaryResponse);
        
        memory.summary = summary;
        memory.summaryMessageCount = messagesToCompress.length;
        
        // Oznacz wiadomości jako zsumaryzowane
        messagesToCompress.forEach(m => {
          m.isSummarized = true;
        });
        
        await memory.save();
        
        console.log(`✅ Compressed ${messagesToCompress.length} messages for session ${sessionId}`);
      } catch (llmError) {
        console.error('LLM compression failed, using simple summary:', llmError);
        // Fallback: proste podsumowanie
        memory.summary = `Poprzednia konwersacja zawierała ${messagesToCompress.length} wiadomości dotyczących: ${this.extractKeywords(messagesText).join(', ')}`;
        memory.summaryMessageCount = messagesToCompress.length;
        await memory.save();
      }
    } catch (error) {
      console.error('Error compressing messages:', error);
    }
  }

  /**
   * Aktualizuj preferencje użytkownika
   */
  static async updatePreferences(userId, sessionId, preferences, agentType = 'concierge') {
    try {
      const memory = await ConversationMemory.findOne({ userId, sessionId, agentType });
      
      if (!memory) {
        // Utwórz nową sesję jeśli nie istnieje
        await ConversationMemory.findOrCreateSession(userId, sessionId, agentType);
        const memory = await ConversationMemory.findOne({ userId, sessionId, agentType });
        memory.updatePreferences(preferences);
        await memory.save();
      } else {
        memory.updatePreferences(preferences);
        await memory.save();
      }
    } catch (error) {
      console.error('Error updating preferences:', error);
    }
  }

  /**
   * Aktualizuj ostatnią interakcję
   */
  static async updateLastInteraction(userId, sessionId, interaction, agentType = 'concierge') {
    try {
      const memory = await ConversationMemory.findOne({ userId, sessionId, agentType });
      
      if (!memory) {
        await ConversationMemory.findOrCreateSession(userId, sessionId, agentType);
        const memory = await ConversationMemory.findOne({ userId, sessionId, agentType });
        memory.lastInteraction = {
          ...interaction,
          timestamp: new Date()
        };
        await memory.save();
      } else {
        memory.lastInteraction = {
          ...interaction,
          timestamp: new Date()
        };
        await memory.save();
      }
    } catch (error) {
      console.error('Error updating last interaction:', error);
    }
  }

  /**
   * Pobierz preferencje użytkownika (z wszystkich sesji)
   */
  static async getUserPreferences(userId, agentType = 'concierge') {
    try {
      const memories = await ConversationMemory.find({ userId, agentType })
        .select('preferences')
        .lean();
      
      if (memories.length === 0) {
        return {
          preferredServices: [],
          preferredLocations: [],
          communicationStyle: 'casual',
          urgencyPattern: 'mixed'
        };
      }
      
      // Agreguj preferencje z wszystkich sesji
      const aggregated = {
        preferredServices: new Set(),
        preferredLocations: new Set(),
        communicationStyles: [],
        urgencyPatterns: []
      };
      
      memories.forEach(m => {
        if (m.preferences?.preferredServices) {
          m.preferences.preferredServices.forEach(s => aggregated.preferredServices.add(s));
        }
        if (m.preferences?.preferredLocations) {
          m.preferences.preferredLocations.forEach(l => aggregated.preferredLocations.add(l));
        }
        if (m.preferences?.communicationStyle) {
          aggregated.communicationStyles.push(m.preferences.communicationStyle);
        }
        if (m.preferences?.urgencyPattern) {
          aggregated.urgencyPatterns.push(m.preferences.urgencyPattern);
        }
      });
      
      // Najczęstszy styl komunikacji
      const mostCommonStyle = aggregated.communicationStyles.length > 0
        ? aggregated.communicationStyles.sort((a, b) =>
            aggregated.communicationStyles.filter(v => v === a).length -
            aggregated.communicationStyles.filter(v => v === b).length
          )[0]
        : 'casual';
      
      // Najczęstszy pattern pilności
      const mostCommonUrgency = aggregated.urgencyPatterns.length > 0
        ? aggregated.urgencyPatterns.sort((a, b) =>
            aggregated.urgencyPatterns.filter(v => v === a).length -
            aggregated.urgencyPatterns.filter(v => v === b).length
          )[0]
        : 'mixed';
      
      return {
        preferredServices: Array.from(aggregated.preferredServices),
        preferredLocations: Array.from(aggregated.preferredLocations),
        communicationStyle: mostCommonStyle,
        urgencyPattern: mostCommonUrgency
      };
    } catch (error) {
      console.error('Error getting user preferences:', error);
      return {
        preferredServices: [],
        preferredLocations: [],
        communicationStyle: 'casual',
        urgencyPattern: 'mixed'
      };
    }
  }

  /**
   * Pomocnicza metoda do ekstrakcji keywords
   */
  static extractKeywords(text) {
    const words = text.toLowerCase().split(/\s+/);
    const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'jest', 'to', 'i', 'w', 'na', 'z', 'o', 'do', 'od'];
    return words
      .filter(w => w.length > 3 && !commonWords.includes(w))
      .slice(0, 10);
  }

  /**
   * Usuń starą sesję (cleanup)
   */
  static async deleteSession(userId, sessionId, agentType = 'concierge') {
    try {
      await ConversationMemory.deleteOne({ userId, sessionId, agentType });
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  }
}

module.exports = ConversationMemoryService;

