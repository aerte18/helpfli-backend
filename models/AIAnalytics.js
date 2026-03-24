/**
 * Model AIAnalytics
 * Tracking użycia AI agentów, metryki jakości, koszty
 */

const mongoose = require('mongoose');

const aiAnalyticsSchema = new mongoose.Schema({
  // Identyfikacja requestu
  requestId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  sessionId: {
    type: String,
    index: true
  },
  
  // Agent info
  agent: {
    type: String,
    enum: ['concierge', 'diagnostic', 'pricing', 'diy', 'matching', 'order_draft', 'post_order', 'provider_orchestrator', 'offer', 'pricing_provider'],
    required: true,
    index: true
  },
  agentChain: [{
    type: String // Kolejność wywołanych agentów w tym request
  }],
  
  // Request info
  endpoint: {
    type: String, // '/api/ai/concierge/v2'
    index: true
  },
  requestSize: {
    type: Number // Size w bytes
  },
  messageCount: {
    type: Number // Liczba wiadomości w kontekście
  },
  
  // Response info
  responseTime: {
    type: Number, // w ms
    required: true
  },
  success: {
    type: Boolean,
    default: true,
    index: true
  },
  error: {
    type: String,
    default: null
  },
  errorType: {
    type: String,
    enum: ['llm_error', 'validation_error', 'timeout', 'rate_limit', 'auth_error', 'other'],
    default: null
  },
  
  // LLM usage
  llmProvider: {
    type: String,
    enum: ['claude', 'ollama', 'openai', 'other'],
    default: 'claude'
  },
  llmModel: {
    type: String, // 'claude-3-5-sonnet-20241022'
    default: null
  },
  tokensInput: {
    type: Number,
    default: 0
  },
  tokensOutput: {
    type: Number,
    default: 0
  },
  tokensTotal: {
    type: Number,
    default: 0
  },
  
  // Koszty
  costEstimate: {
    type: Number, // w groszach (PLN * 100)
    default: 0
  },
  currency: {
    type: String,
    default: 'PLN'
  },
  
  // Jakość odpowiedzi
  quality: {
    confidence: {
      type: Number, // 0-1
      default: null
    },
    relevance: {
      type: Number, // 0-1 (jeśli ocenione)
      default: null
    }
  },
  
  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  date: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Indexy dla szybkiego wyszukiwania i agregacji
aiAnalyticsSchema.index({ agent: 1, createdAt: -1 });
aiAnalyticsSchema.index({ userId: 1, createdAt: -1 });
aiAnalyticsSchema.index({ success: 1, createdAt: -1 });
aiAnalyticsSchema.index({ date: 1, agent: 1 });
aiAnalyticsSchema.index({ llmProvider: 1, createdAt: -1 });

// TTL index - usuń po 90 dniach (opcjonalne)
// aiAnalyticsSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('AIAnalytics', aiAnalyticsSchema);

