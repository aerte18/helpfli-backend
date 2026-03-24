/**
 * Model ConversationMemory
 * Przechowuje historię rozmów i kontekst dla AI agentów
 */

const mongoose = require('mongoose');

const conversationMemorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  agentType: {
    type: String,
    enum: ['concierge', 'provider_assistant', 'both'],
    default: 'concierge',
    index: true
  },
  
  // Historia wiadomości
  messages: [{
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    agent: {
      type: String, // 'concierge', 'diagnostic', 'pricing', etc.
      default: 'concierge'
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    // Dla kompresji - czy wiadomość jest w summary
    isSummarized: {
      type: Boolean,
      default: false
    }
  }],
  
  // Kompresowany summary dla długich rozmów (ostatnie 20+ wiadomości)
  summary: {
    type: String,
    default: null
  },
  summaryMessageCount: {
    type: Number,
    default: 0 // Ile wiadomości zostało zsumaryzowanych
  },
  
  // Preferencje użytkownika wyekstrahowane z rozmów
  preferences: {
    preferredServices: [{
      type: String
    }],
    preferredLocations: [{
      type: String
    }],
    communicationStyle: {
      type: String,
      enum: ['formal', 'casual', 'brief', 'detailed'],
      default: 'casual'
    },
    urgencyPattern: {
      type: String,
      enum: ['often_urgent', 'usually_flexible', 'mixed'],
      default: 'mixed'
    }
  },
  
  // Kontekst ostatniej interakcji (dla szybkiego dostępu)
  lastInteraction: {
    detectedService: String,
    urgency: String,
    location: String,
    nextStep: String,
    timestamp: Date
  },
  
  // Statystyki sesji
  stats: {
    totalMessages: {
      type: Number,
      default: 0
    },
    averageResponseTime: {
      type: Number, // w ms
      default: 0
    },
    satisfactionScore: {
      type: Number, // 0-5
      default: null
    }
  },
  
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    default: function() {
      // Wygaśnięcie po 90 dniach (opcjonalne czyszczenie)
      return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    }
  }
}, {
  timestamps: true
});

// Indexy dla szybkiego wyszukiwania
conversationMemorySchema.index({ userId: 1, sessionId: 1 });
conversationMemorySchema.index({ userId: 1, updatedAt: -1 });
// TTL index - automatyczne usuwanie po 90 dniach (opcjonalne, można włączyć)
// conversationMemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7776000 });

// Metoda do dodawania wiadomości
conversationMemorySchema.methods.addMessage = function(role, content, agent = 'concierge', metadata = {}) {
  this.messages.push({
    role,
    content,
    timestamp: new Date(),
    agent,
    metadata
  });
  
  // Ograniczenie do ostatnich 50 wiadomości (przed kompresją)
  if (this.messages.length > 50) {
    // Oznacz stare wiadomości jako do zsumaryzowania
    const oldMessages = this.messages.slice(0, this.messages.length - 50);
    oldMessages.forEach(msg => {
      msg.isSummarized = true;
    });
    
    // Kompresuj stare wiadomości (wywołamy summarization async)
    this.summaryMessageCount = oldMessages.length;
  }
  
  this.stats.totalMessages = this.messages.length;
  this.updatedAt = new Date();
  
  return this;
};

// Metoda do pobierania kontekstu (ostatnie N wiadomości + summary)
conversationMemorySchema.methods.getContext = function(limit = 10) {
  const recentMessages = this.messages
    .filter(m => !m.isSummarized)
    .slice(-limit)
    .map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp
    }));
  
  return {
    summary: this.summary,
    summaryMessageCount: this.summaryMessageCount,
    recentMessages,
    preferences: this.preferences,
    lastInteraction: this.lastInteraction
  };
};

// Metoda do aktualizacji preferencji
conversationMemorySchema.methods.updatePreferences = function(newPreferences) {
  if (newPreferences.preferredServices) {
    this.preferences.preferredServices = [
      ...new Set([...this.preferences.preferredServices, ...newPreferences.preferredServices])
    ];
  }
  
  if (newPreferences.preferredLocations) {
    this.preferences.preferredLocations = [
      ...new Set([...this.preferences.preferredLocations, ...newPreferences.preferredLocations])
    ];
  }
  
  if (newPreferences.communicationStyle) {
    this.preferences.communicationStyle = newPreferences.communicationStyle;
  }
  
  if (newPreferences.urgencyPattern) {
    this.preferences.urgencyPattern = newPreferences.urgencyPattern;
  }
  
  this.updatedAt = new Date();
  return this;
};

// Static method do znajdowania lub tworzenia sesji
conversationMemorySchema.statics.findOrCreateSession = async function(userId, sessionId, agentType = 'concierge') {
  let memory = await this.findOne({ userId, sessionId, agentType });
  
  if (!memory) {
    memory = await this.create({
      userId,
      sessionId,
      agentType,
      messages: [],
      preferences: {
        preferredServices: [],
        preferredLocations: [],
        communicationStyle: 'casual',
        urgencyPattern: 'mixed'
      },
      stats: {
        totalMessages: 0,
        averageResponseTime: 0
      }
    });
  }
  
  return memory;
};

module.exports = mongoose.model('ConversationMemory', conversationMemorySchema);

