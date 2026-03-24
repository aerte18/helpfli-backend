// Model dla partnerów API (Publiczne API dla partnerów)
const mongoose = require('mongoose');

const partnerSchema = new mongoose.Schema({
  // Podstawowe dane partnera
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  company: { type: String }, // Nazwa firmy partnera
  
  // API Key
  apiKey: { type: String, required: true, unique: true, index: true },
  apiSecret: { type: String, required: true }, // Hashed
  
  // Status i uprawnienia
  status: { 
    type: String, 
    enum: ['pending', 'active', 'suspended', 'revoked'], 
    default: 'pending' 
  },
  isActive: { type: Boolean, default: false },
  
  // Uprawnienia API
  permissions: {
    readOrders: { type: Boolean, default: true },
    readProviders: { type: Boolean, default: true },
    readAnalytics: { type: Boolean, default: false },
    writeWebhooks: { type: Boolean, default: false }
  },
  
  // Rate limiting
  rateLimit: {
    requestsPerMinute: { type: Number, default: 60 },
    requestsPerHour: { type: Number, default: 1000 },
    requestsPerDay: { type: Number, default: 10000 }
  },
  
  // Webhooks
  webhooks: [{
    url: { type: String, required: true },
    events: [{ type: String }], // order.created, order.completed, etc.
    secret: { type: String }, // Secret do weryfikacji webhooka
    isActive: { type: Boolean, default: true }
  }],
  
  // Statystyki użycia
  stats: {
    totalRequests: { type: Number, default: 0 },
    lastRequestAt: { type: Date },
    requestsToday: { type: Number, default: 0 },
    requestsThisHour: { type: Number, default: 0 },
    lastResetAt: { type: Date, default: Date.now }
  },
  
  // Metadane
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: { type: Date },
  expiresAt: { type: Date }, // Opcjonalna data wygaśnięcia
  notes: { type: String }, // Notatki admina
}, {
  timestamps: true
});

// Indeksy
partnerSchema.index({ apiKey: 1 });
partnerSchema.index({ status: 1, isActive: 1 });
partnerSchema.index({ email: 1 });

// Metody
partnerSchema.methods.canAccess = function(permission) {
  if (!this.isActive || this.status !== 'active') return false;
  return this.permissions[permission] === true;
};

partnerSchema.methods.checkRateLimit = function() {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  // Reset dzienny
  if (this.stats.lastResetAt < dayAgo) {
    this.stats.requestsToday = 0;
    this.stats.requestsThisHour = 0;
    this.stats.lastResetAt = now;
  }
  
  // Reset godzinny
  if (this.stats.lastRequestAt < hourAgo) {
    this.stats.requestsThisHour = 0;
  }
  
  // Sprawdź limity
  if (this.stats.requestsThisHour >= this.rateLimit.requestsPerHour) {
    return { allowed: false, reason: 'hourly_limit_exceeded' };
  }
  if (this.stats.requestsToday >= this.rateLimit.requestsPerDay) {
    return { allowed: false, reason: 'daily_limit_exceeded' };
  }
  
  return { allowed: true };
};

partnerSchema.methods.incrementRequest = function() {
  this.stats.totalRequests += 1;
  this.stats.requestsToday += 1;
  this.stats.requestsThisHour += 1;
  this.stats.lastRequestAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Partner', partnerSchema);













