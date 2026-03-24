const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'order_accepted',
      'order_funded',
      'order_completed',
      'order_disputed',
      'order_updated',
      'new_quote',
      'new_offer',
      'new_order',
      'payment_received',
      'new_direct_order',
      'subscription_expiring',
      'subscription_expired',
      'subscription_renewed',
      'referral_reward',
      'system_announcement',
      'limit_warning',
      'limit_exceeded',
      'chat_message'
    ]
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  link: {
    type: String,
    default: null // URL do powiązanego zasobu (np. /orders/123)
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    default: null
  },
  // Metadata dla różnych typów powiadomień
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexy dla wydajności
NotificationSchema.index({ user: 1, read: 1, createdAt: -1 });
NotificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);

