const mongoose = require('mongoose');

const notificationLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { 
    type: String, 
    enum: [
      'subscription_expiry_7days',
      'subscription_expiry_3days',
      'subscription_expiry_1day',
      'subscription_expired',
      'promo_expiring',
      'sponsor_ad_expiring',
      'sponsor_ad_expired',
      'order_assigned',
      'order_completed',
      'payment_received',
      'invoice_generated',
      'other'
    ],
    required: true,
    index: true
  },
  channel: { 
    type: String, 
    enum: ['email', 'sms', 'push'],
    required: true,
    index: true
  },
  status: { 
    type: String, 
    enum: ['pending', 'sent', 'failed', 'delivered'],
    default: 'pending',
    index: true
  },
  subject: { type: String }, // Dla emaili
  message: { type: String }, // Treść wiadomości
  recipient: { type: String, required: true }, // Email lub numer telefonu
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate' }, // Opcjonalnie - ID szablonu
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // Dodatkowe dane (np. subscriptionId, orderId)
  sentAt: { type: Date },
  deliveredAt: { type: Date },
  error: { type: String }, // Błąd jeśli status = 'failed'
  retryCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// Indeksy dla szybkiego wyszukiwania
notificationLogSchema.index({ user: 1, createdAt: -1 });
notificationLogSchema.index({ type: 1, status: 1, createdAt: -1 });
notificationLogSchema.index({ channel: 1, status: 1 });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);

