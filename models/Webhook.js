// Model dla webhooków partnerów
const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  // Partner, który posiada webhook
  partner: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', required: true },
  
  // URL webhooka
  url: { type: String, required: true },
  
  // Wydarzenia, które wywołują webhook
  events: [{ 
    type: String,
    enum: [
      'order.created',
      'order.accepted',
      'order.completed',
      'order.cancelled',
      'payment.succeeded',
      'payment.failed',
      'provider.registered',
      'rating.created',
      'subscription.created',
      'subscription.cancelled'
    ]
  }],
  
  // Secret do weryfikacji podpisu
  secret: { type: String, required: true },
  
  // Status
  isActive: { type: Boolean, default: true },
  
  // Statystyki
  stats: {
    totalSent: { type: Number, default: 0 },
    successful: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    lastSentAt: { type: Date },
    lastSuccessAt: { type: Date },
    lastFailureAt: { type: Date },
    lastFailureReason: { type: String }
  },
  
  // Konfiguracja
  config: {
    timeout: { type: Number, default: 30000 }, // 30 sekund
    retries: { type: Number, default: 3 },
    retryDelay: { type: Number, default: 1000 } // 1 sekunda
  }
}, {
  timestamps: true
});

// Indeksy
webhookSchema.index({ partner: 1, isActive: 1 });
webhookSchema.index({ 'events': 1 });

module.exports = mongoose.model('Webhook', webhookSchema);













