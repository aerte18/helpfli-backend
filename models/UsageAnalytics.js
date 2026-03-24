const mongoose = require('mongoose');

const UsageAnalyticsSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  date: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  monthKey: { 
    type: String, 
    required: true,
    index: true // Format: 'YYYY-MM'
  },
  planKey: {
    type: String,
    required: true
  },
  // AI Concierge usage
  aiQueries: { type: Number, default: 0 },
  aiQueriesLimit: { type: Number, default: 50 }, // Limit dla planu
  aiQueriesPaid: { type: Number, default: 0 }, // Płatne użycia (pay-per-use)
  
  // Provider responses
  providerResponses: { type: Number, default: 0 },
  providerResponsesLimit: { type: Number, default: 10 }, // Limit dla planu
  providerResponsesPaid: { type: Number, default: 0 }, // Płatne użycia
  
  // Provider AI Chat usage
  providerAiChatQueries: { type: Number, default: 0 },
  providerAiChatQueriesLimit: { type: Number, default: 20 }, // Limit dla planu FREE (20), nielimitowane dla STD/PRO
  providerAiChatQueriesPaid: { type: Number, default: 0 }, // Płatne użycia
  
  // Fast-Track usage
  fastTrackUsed: { type: Number, default: 0 },
  fastTrackFree: { type: Number, default: 0 }, // Darmowe z planu
  fastTrackPaid: { type: Number, default: 0 }, // Płatne użycia
  
  // Orders created
  ordersCreated: { type: Number, default: 0 },
  
  // Revenue generated (dla providerów)
  revenueGenerated: { type: Number, default: 0 }, // w groszach
  
  // Platform fee paid
  platformFeePaid: { type: Number, default: 0 }, // w groszach
}, { timestamps: true });

// Index dla szybkiego wyszukiwania
UsageAnalyticsSchema.index({ user: 1, monthKey: 1 }, { unique: true });
UsageAnalyticsSchema.index({ monthKey: 1 });
UsageAnalyticsSchema.index({ date: -1 });

// Metoda do zwiększania użycia
UsageAnalyticsSchema.statics.incrementUsage = async function(userId, monthKey, field, amount = 1, paid = false) {
  const update = { $inc: { [field]: amount } };
  if (paid) {
    update.$inc[`${field}Paid`] = amount;
  }
  
  return await this.findOneAndUpdate(
    { user: userId, monthKey },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('UsageAnalytics', UsageAnalyticsSchema);







