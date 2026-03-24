const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  // Podstawowe dane firmy
  name: { type: String, required: true },
  nip: { type: String, required: true, unique: true },
  regon: { type: String },
  krs: { type: String },
  
  // Dane kontaktowe
  email: { type: String, required: true },
  phone: { type: String },
  website: { type: String },
  
  // Adres
  address: {
    street: String,
    city: String,
    postalCode: String,
    country: { type: String, default: 'Polska' }
  },
  
  // Opis firmy
  description: String,
  logo: String, // URL do logo
  banner: String, // URL do banera
  
  // Właściciel i zespół
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // właściciel firmy
  managers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // managerzy
  providers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // wykonawcy
  
  // Status i weryfikacja
  status: { 
    type: String, 
    enum: ['pending', 'active', 'suspended', 'rejected'], 
    default: 'pending' 
  },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Statystyki firmy
  stats: {
    totalOrders: { type: Number, default: 0 },
    completedOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 }, // w groszach
    averageRating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 }
  },
  
  // Ustawienia firmy
  settings: {
    allowProviderRegistration: { type: Boolean, default: true }, // czy pozwala na rejestrację nowych providerów
    autoApproveProviders: { type: Boolean, default: false }, // czy automatycznie zatwierdza nowych providerów
    requireManagerApproval: { type: Boolean, default: true }, // czy wymaga zatwierdzenia przez managera
    defaultProviderLevel: { type: String, enum: ['basic', 'standard', 'pro'], default: 'basic' },
    maxProviders: { type: Number, default: 50 } // maksymalna liczba providerów
  },
  
  // Subskrypcja firmy
  subscription: {
    plan: { type: String, enum: ['basic', 'standard', 'premium'], default: 'basic' },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: false }
  },
  
  // Onboarding
  onboardingCompleted: { type: Boolean, default: false },
  onboardingCompletedAt: { type: Date },
  onboardingSteps: {
    teamAdded: { type: Boolean, default: false },
    workflowConfigured: { type: Boolean, default: false },
    planSelected: { type: Boolean, default: false },
    resourcePoolConfigured: { type: Boolean, default: false }
  },
  
  // Resource Pool - wspólne limity dla całej firmy
  resourcePool: {
    // AI Queries
    aiQueriesLimit: { type: Number, default: 0 },
    aiQueriesUsed: { type: Number, default: 0 },
    aiQueriesResetDate: { type: Date },
    // Fast-Track
    fastTrackLimit: { type: Number, default: 0 },
    fastTrackUsed: { type: Number, default: 0 },
    fastTrackResetDate: { type: Date },
    // Provider Responses
    providerResponsesLimit: { type: Number, default: 0 },
    providerResponsesUsed: { type: Number, default: 0 },
    providerResponsesResetDate: { type: Date },
    // Strategia alokacji
    allocationStrategy: { type: String, enum: ['equal', 'priority', 'manual'], default: 'equal' },
    priorityMembers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    manualAllocations: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  
  // Metadane
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Indeksy dla wydajności
companySchema.index({ nip: 1 });
companySchema.index({ owner: 1 });
companySchema.index({ status: 1 });
companySchema.index({ verified: 1 });

// Wirtualne pola
companySchema.virtual('fullAddress').get(function() {
  if (!this.address) return '';
  return `${this.address.street || ''}, ${this.address.postalCode || ''} ${this.address.city || ''}, ${this.address.country || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
});

companySchema.virtual('teamSize').get(function() {
  return (this.providers?.length || 0) + (this.managers?.length || 0) + 1; // +1 for owner
});

// Metody instancji
companySchema.methods.addProvider = function(providerId) {
  if (!this.providers.includes(providerId)) {
    this.providers.push(providerId);
    return this.save();
  }
  return Promise.resolve(this);
};

companySchema.methods.removeProvider = function(providerId) {
  this.providers = this.providers.filter(id => !id.equals(providerId));
  return this.save();
};

companySchema.methods.addManager = function(managerId) {
  if (!this.managers.includes(managerId)) {
    this.managers.push(managerId);
    return this.save();
  }
  return Promise.resolve(this);
};

companySchema.methods.removeManager = function(managerId) {
  this.managers = this.managers.filter(id => !id.equals(managerId));
  return this.save();
};

companySchema.methods.isOwner = function(userId) {
  return this.owner.equals(userId);
};

companySchema.methods.isManager = function(userId) {
  return this.managers.some(id => id.equals(userId));
};

companySchema.methods.isProvider = function(userId) {
  return this.providers.some(id => id.equals(userId));
};

companySchema.methods.canManage = function(userId) {
  return this.isOwner(userId) || this.isManager(userId);
};

companySchema.methods.canAccess = function(userId) {
  return this.isOwner(userId) || this.isManager(userId) || this.isProvider(userId);
};

// Metody statyczne
companySchema.statics.findByOwner = function(ownerId) {
  return this.find({ owner: ownerId, isActive: true });
};

companySchema.statics.findByProvider = function(providerId) {
  return this.find({ 
    $or: [
      { providers: providerId },
      { managers: providerId },
      { owner: providerId }
    ],
    isActive: true 
  });
};

companySchema.statics.findVerified = function() {
  return this.find({ verified: true, status: 'active', isActive: true });
};

// Pre-save middleware
companySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Company', companySchema);











