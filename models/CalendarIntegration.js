// Integracje kalendarzowe użytkowników
const mongoose = require('mongoose');

const calendarIntegrationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, enum: ['google', 'outlook'], required: true },
  
  // Tokeny OAuth
  accessToken: { type: String, required: true },
  refreshToken: { type: String },
  tokenExpiresAt: { type: Date },
  
  // Informacje o koncie
  email: { type: String },
  calendarId: { type: String, default: 'primary' }, // ID kalendarza (domyślnie primary)
  
  // Status
  active: { type: Boolean, default: true },
  lastSyncAt: { type: Date },
  syncError: { type: String },
  
  // Ustawienia
  autoSync: { type: Boolean, default: true }, // Automatyczna synchronizacja
  syncOrders: { type: Boolean, default: true }, // Synchronizuj zlecenia
  syncOffers: { type: Boolean, default: false }, // Synchronizuj oferty
  
  metadata: { type: Object, default: {} }
}, {
  timestamps: true
});

// Indexy
calendarIntegrationSchema.index({ user: 1, provider: 1 }, { unique: true });
calendarIntegrationSchema.index({ active: 1, lastSyncAt: 1 });

module.exports = mongoose.models.CalendarIntegration || mongoose.model('CalendarIntegration', calendarIntegrationSchema);













