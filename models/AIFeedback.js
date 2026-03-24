const mongoose = require('mongoose');

const aiFeedbackSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  orderId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Order',
    default: null
  },
  orderDraftId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrderDraft',
    default: null
  },
  
  // Informacje o problemie
  description: { type: String, required: true },
  serviceCategory: { type: String, default: null },
  serviceCode: { type: String, default: null },
  location: { type: String, default: null },
  
  // Rozwiązanie zaproponowane przez AI
  aiSolution: {
    diySteps: [{ type: Object }],
    requiredParts: [{ type: Object }],
    estimatedCost: { type: Object },
    estimatedTime: { type: String },
    deviceIdentification: { type: Object },
    conditionAssessment: { type: Object }
  },
  
  // Feedback użytkownika
  feedback: {
    worked: { 
      type: Boolean, 
      default: null 
    }, // true = zadziałało, false = nie zadziałało, null = nie wiadomo
    rating: { 
      type: Number, 
      min: 1, 
      max: 5, 
      default: null 
    }, // 1-5 gwiazdek
    comment: { 
      type: String, 
      default: null 
    }, // Opcjonalny komentarz
    actualCost: { 
      type: Number, 
      default: null 
    }, // Rzeczywisty koszt (jeśli znany)
    actualTime: { 
      type: String, 
      default: null 
    }, // Rzeczywisty czas realizacji
    usedParts: [{ 
      name: String,
      actualPrice: Number,
      wasAvailable: Boolean
    }], // Części które faktycznie użyto
    issues: [{ 
      type: String 
    }] // Problemy z rozwiązaniem (np. "część niedostępna", "cena za wysoka")
  },
  
  // Nowe pola dla feedbacku z rozmów AI
  sessionId: {
    type: String,
    index: true
  },
  messageId: {
    type: String, // ID konkretnej wiadomości w sesji
    index: true
  },
  agent: {
    type: String, // 'concierge', 'diagnostic', 'pricing', 'provider_assistant', etc.
    enum: ['concierge', 'diagnostic', 'pricing', 'diy', 'matching', 'order_draft', 'post_order', 'provider_orchestrator', 'offer', 'pricing_provider', 'other'],
    default: 'concierge',
    index: true
  },
  
  // Szybki feedback (thumbs up/down)
  quickFeedback: {
    type: String,
    enum: ['positive', 'negative', null],
    default: null
  },
  wasHelpful: {
    type: Boolean,
    default: null
  },
  
  // Akcja podjęta przez użytkownika po odpowiedzi AI
  actionTaken: {
    type: String,
    enum: ['created_order', 'contacted_provider', 'tried_diy', 'viewed_pricing', 'searched_providers', 'none', 'other'],
    default: null
  },
  actionTimestamp: {
    type: Date,
    default: null
  },
  
  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Metadane
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  feedbackGivenAt: { type: Date, default: null }
});

// Indeksy dla szybkiego wyszukiwania
aiFeedbackSchema.index({ user: 1, createdAt: -1 });
aiFeedbackSchema.index({ serviceCategory: 1, feedback: 1 });
aiFeedbackSchema.index({ serviceCode: 1, 'feedback.worked': 1 });
aiFeedbackSchema.index({ location: 1 });
aiFeedbackSchema.index({ sessionId: 1, messageId: 1 });
aiFeedbackSchema.index({ agent: 1, 'feedback.rating': 1 });
aiFeedbackSchema.index({ agent: 1, quickFeedback: 1 });
aiFeedbackSchema.index({ actionTaken: 1, createdAt: -1 });

const AIFeedback = mongoose.model('AIFeedback', aiFeedbackSchema);

module.exports = AIFeedback;










