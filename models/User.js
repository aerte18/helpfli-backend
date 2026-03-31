const mongoose = require('mongoose');

const ProviderStatusSchema = new mongoose.Schema({
  isOnline: { type: Boolean, default: false },
  lastSeenAt: { type: Date, default: Date.now },
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  emailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String },
  emailVerificationExpires: { type: Date },
  passwordResetToken: { type: String },
  passwordResetExpires: { type: Date },
  requiresPasswordChange: { type: Boolean, default: false }, // Wymuś zmianę hasła przy pierwszym logowaniu
  role: { type: String, enum: ['client', 'provider', 'admin', 'company_owner', 'company_manager'], default: 'client' },
  isB2B: { type: Boolean, default: false },
  phone: { type: String },
  onboardingCompleted: { type: Boolean, default: false },
  // opcjonalnie krótkie pola profilu:
  availability: { type: String, default: "" },
  priceNote: { type: String, default: "" },
  bio: { type: String, default: "" },
  headline: { type: String, default: "", maxlength: 60 }, // Krótki nagłówek (ok. 40-60 znaków) wyświetlany w kartach
  location: { type: String }, // Np. "Warszawa"
  address: { type: String }, // Pełny adres np. "ul. Marszałkowska 1, Warszawa"
  locationCoords: { // Nowe pole
    lat: { type: Number, default: 52.2297 },
    lng: { type: Number, default: 21.0122 }
  },
  level: { type: String, enum: ['basic', 'standard', 'pro'], default: 'standard' }, // Nowe pole
  providerLevel: { type: String, enum: ['basic', 'standard', 'pro'], default: 'standard' }, // Poziom wykonawcy
  providerTier: { type: String, enum: ['basic', 'standard', 'pro'], default: 'basic' }, // Tier providera (wpływa na priorytet)
  badges: { type: [String], default: [] }, // Odznaki: ["verified", "top_ai", "pro", etc.]
  // Nowe pola Pakietu 2
  rankingPoints: { type: Number, default: 0 },
  promo: {
    highlightUntil: { type: Date, default: null },   // obwódka fioletowa
    topUntil: { type: Date, default: null },         // badge TOP
    aiRecommendedUntil: { type: Date, default: null } // badge "Polecane przez AI"
  },
  
  // AI Concierge usage tracking
  aiConciergeUsage: [{
    date: { type: Date, default: Date.now },
    description: String,
    service: String
  }],
  
  // Nowe pola dla pakietów providerów
  monthlyOffersUsed: { type: Number, default: 0 }, // Liczba użytych ofert w tym miesiącu
  monthlyOffersLimit: { type: Number, default: 10 }, // Limit ofert miesięcznie (10 dla FREE, 50 dla STD, unlimited dla PRO)
  favoriteClients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Ulubieni klienci
  profileViews: { type: Number, default: 0 }, // Liczba odsłon profilu
  wonOffers: { type: Number, default: 0 }, // Liczba wygranych ofert
  averageOfferPrice: { type: Number, default: 0 }, // Średnia cena ofert
  successRate: { type: Number, default: 0 }, // Skuteczność wygranych ofert (%)
  lastMonthlyReport: { type: Date, default: null }, // Data ostatniego raportu miesięcznego
  isTopProvider: { type: Boolean, default: false }, // Czy jest Top Provider na mapie
  hasHelpfliGuarantee: { type: Boolean, default: false }, // Gwarancja Helpfli+
  
  // Pełna struktura KYC
  kyc: {
    status: { 
      type: String, 
      enum: ['not_started','in_progress','submitted','verified','rejected'], 
      default: 'not_started' 
    },
    type: { type: String, enum: ['individual','company'], default: 'individual' },
    rejectionReason: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },

    // dane wnioskodawcy (trzymaj tylko to, co potrzebne prawnie)
    firstName: String,
    lastName: String,
    idNumber: String,        // np. dowód (opcjonalnie)
    companyName: String,     // dla type='company'
    nip: String,             // dla type='company'

    // linki do plików (lokalne URL-e serwowane statycznie)
    docs: {
      idFrontUrl: String,
      idBackUrl: String,
      selfieUrl: String,
      companyDocUrl: String, // KRS/CEIDG PDF lub skan
    }
  },
  ratingAvg: { type: Number, default: 0 },
  verification: {
    status: { type: String, enum: ["unverified","pending","verified","rejected"], default:"unverified" },
    method: { type: String, enum: ["kyc_id","company_reg","manual","none"], default: "none" },
    verifiedAt: { type: Date },
    reviewer: { type: String }, // adminId/email
  },
  // Pola związane z firmami
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null }, // firma do której należy użytkownik
  roleInCompany: { type: String, enum: ['owner', 'manager', 'provider', 'none'], default: 'none' }, // rola w firmie
  companyRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyRole', default: null }, // Custom rola w firmie (dla B2B)
  companyInvitation: { // zaproszenie do firmy
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    invitedAt: { type: Date },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    expiresAt: { type: Date }
  },
  companyMembershipHistory: [{ // Historia członkostwa w firmach
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    role: { type: String, enum: ['owner', 'manager', 'provider'] },
    joinedAt: { type: Date },
    leftAt: { type: Date },
    reason: { type: String }, // 'removed', 'left', 'company_deleted'
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  
  // Zgody RODO
  marketingConsent: { type: Boolean, default: false },
  consents: {
    analytics: { type: Boolean, default: false },
    cookies: { type: Boolean, default: false },
    updatedAt: { type: Date, default: null }
  },
  anonymized: { type: Boolean, default: false },
  anonymizedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },

  // Web-push subskrypcje
  pushSubs: [{
    endpoint: String,
    keys: { p256dh: String, auth: String },
    createdAt: { type: Date, default: Date.now }
  }],
  price: { type: Number, default: 100 }, // Nowe pole
  time: { type: Number, default: 2 }, // hours, Nowe pole
  avatar: { type: String, default: 'https://via.placeholder.com/150' }, // Nowe pole dla avatarów
  services: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
  service: { type: String }, // Główna usługa (string)
  verified: { type: Boolean, default: false }, // Status weryfikacji
  b2b: { type: Boolean, default: false }, // Czy B2B
  instantChat: { type: Boolean, default: false }, // Chat natychmiastowy
  vatInvoice: { type: Boolean, default: false }, // Faktura VAT
  // Preferencje płatności dla providera (jakie zlecenia akceptuje)
  providerPaymentPreference: { 
    type: String, 
    enum: ['system', 'external', 'both'], 
    default: 'system' 
  }, // Provider akceptuje: tylko Helpfli, tylko poza systemem, lub oba
  // Dane do faktur (dla roli client)
  billing: {
    customerType: { type: String, enum: ['individual', 'company'], default: 'individual' },
    invoiceMode: { type: String, enum: ['per_order', 'monthly'], default: 'per_order' },
    wantInvoice: { type: Boolean, default: false },
    companyName: { type: String, default: '' },
    nip: { type: String, default: '' },
    street: { type: String, default: '' },
    city: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    country: { type: String, default: 'Polska' }
  },
  // Program lojalnościowy + flaga klienta
  loyaltyPoints: { type: Number, default: 0 },
  loyaltyHistory: [{
    delta: Number,
    reason: String,
    ts: { type: Date, default: Date.now }
  }],
  referralCode: { type: String, unique: true, sparse: true }, // Unikalny kod referencyjny użytkownika
  // Stripe Connect – konto do automatycznych wypłat dla wykonawców
  stripeAccountId: { type: String, default: "" },
  stripeCustomerId: { type: String, default: null, index: true }, // Stripe Customer ID dla subskrypcji
  stripeConnectStatus: {
    chargesEnabled: { type: Boolean, default: false },
    payoutsEnabled: { type: Boolean, default: false },
    detailsSubmitted: { type: Boolean, default: false },
    requirementsDue: { type: Boolean, default: false },
    lastCheckedAt: { type: Date, default: null }
  },
  // Email Marketing
  emailMarketing: {
    welcome2Sent: { type: Boolean, default: false },
    welcome2SentAt: { type: Date },
    welcome3Sent: { type: Boolean, default: false },
    welcome3SentAt: { type: Date },
    reEngagement7Sent: { type: Boolean, default: false },
    reEngagement7SentAt: { type: Date },
    reEngagement14Sent: { type: Boolean, default: false },
    reEngagement14SentAt: { type: Date },
    reEngagement30Sent: { type: Boolean, default: false },
    reEngagement30SentAt: { type: Date },
    lastActivity: { type: Date, default: Date.now } // Ostatnia aktywność użytkownika
  },
  // Preferencje powiadomień
  notificationPreferences: {
    subscriptionExpiry: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
      daysBefore: [{ type: Number }] // [7, 3, 1] - które dni przed wygaśnięciem
    },
    promoExpiring: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true }
    },
    orderUpdates: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true }
    },
    paymentUpdates: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true }
    },
    marketing: {
      email: { type: Boolean, default: false },
      sms: { type: Boolean, default: false }
    }
  },
  // Samofakturowanie (self-billing) dla providerów B2B
  selfBillingEnabled: { type: Boolean, default: false },
  selfBillingAgreementAcceptedAt: { type: Date, default: null },
  isClient: { type: Boolean, default: true },
  provider_status: { type: ProviderStatusSchema, default: () => ({}) },
  twoFactorEnabled: { type: Boolean, default: false }, // Dwuskładnikowa autoryzacja
  twoFactorSecret: { type: String }, // Sekret TOTP (zaszyfrowany)
  twoFactorBackupCodes: [{ type: String }], // Kody zapasowe (zaszyfrowane)
  // Statusy promocji (czasowe)
  promo: {
    highlightUntil: { type: Date, default: null },      // fioletowa obwódka
    topBadgeUntil: { type: Date, default: null },       // badge „TOP"
    pinBoostUntil: { type: Date, default: null },       // większa pinezka na mapie
    aiTopTagUntil: { type: Date, default: null },       // badge „AI poleca"
    rankBoostUntil: { type: Date, default: null },      // do kiedy naliczać punkty z pakietu
    rankBoostPoints: { type: Number, default: 0 },      // ile punktów rankingowych
    // Auto-odnawianie (Stripe)
    autoRenew: { type: Boolean, default: false },
    subscriptionId: { type: String, default: "" },
    subscriptionProductKey: { type: String, default: "" }, // który pakiet odnawiamy
    // Snapshot metryk na start pakietu (do obliczeń ROI)
    metricsAtStart: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      quoteRequests: { type: Number, default: 0 },
      chatsStarted: { type: Number, default: 0 },
      ordersWon: { type: Number, default: 0 },
      at: { type: Date, default: null }
    }
  },
  // Prosta analityka (zliczana eventami)
  metrics: {
    impressions: { type: Number, default: 0 },   // wyświetlenia karty na liście
    mapOpens: { type: Number, default: 0 },      // zobaczenia na mapie
    clicks: { type: Number, default: 0 },        // klik „Wybierz profil"
    quoteRequests: { type: Number, default: 0 }, // „Zapytaj o wycenę"
    chatsStarted: { type: Number, default: 0 },  // start czatu
    ordersWon: { type: Number, default: 0 },     // zaakceptowane zlecenia
    periodStart: { type: Date, default: () => new Date() }, // do zliczania w okresie
  },
  // Gamification
  gamification: {
    badges: [{ type: String }], // Lista odznak (np. "first_order", "10_reviews", "pro_member")
    loginStreak: { type: Number, default: 0 }, // Dni z rzędu logowania
    lastLoginDate: { type: Date }, // Ostatnia data logowania (do obliczania streak)
    achievements: [{
      id: String, // ID osiągnięcia
      unlockedAt: Date,
      progress: Number // Postęp (0-100)
    }],
    tier: { 
      type: String, 
      enum: ['bronze', 'silver', 'gold', 'platinum'], 
      default: 'bronze' 
    } // Poziom lojalnościowy
  },
}, {
  timestamps: true
});

// Metody instancji dla zarządzania firmami
userSchema.methods.isCompanyOwner = function() {
  return this.role === 'company_owner' || this.roleInCompany === 'owner';
};

userSchema.methods.isCompanyManager = function() {
  return this.role === 'company_manager' || this.roleInCompany === 'manager';
};

userSchema.methods.isCompanyProvider = function() {
  return this.roleInCompany === 'provider';
};

userSchema.methods.isInCompany = function() {
  return this.company !== null && this.roleInCompany !== 'none';
};

userSchema.methods.canManageCompany = function() {
  return this.isCompanyOwner() || this.isCompanyManager();
};

userSchema.methods.acceptCompanyInvitation = function() {
  if (this.companyInvitation && this.companyInvitation.status === 'pending') {
    this.company = this.companyInvitation.companyId;
    this.roleInCompany = 'provider'; // domyślna rola dla nowych członków
    this.companyInvitation.status = 'accepted';
    return this.save();
  }
  return Promise.resolve(this);
};

userSchema.methods.rejectCompanyInvitation = function() {
  if (this.companyInvitation && this.companyInvitation.status === 'pending') {
    this.companyInvitation.status = 'rejected';
    return this.save();
  }
  return Promise.resolve(this);
};

userSchema.methods.leaveCompany = function() {
  this.company = null;
  this.roleInCompany = 'none';
  this.companyInvitation = undefined;
  return this.save();
};

// Metody statyczne
userSchema.statics.findByCompany = function(companyId) {
  return this.find({ company: companyId, isActive: true });
};

userSchema.statics.findCompanyOwners = function() {
  return this.find({ role: 'company_owner', isActive: true });
};

userSchema.statics.findCompanyManagers = function() {
  return this.find({ 
    $or: [
      { role: 'company_manager' },
      { roleInCompany: 'manager' }
    ],
    isActive: true 
  });
};

// Helpful indexes for role-based queries and filtering
userSchema.index({ role: 1 });
userSchema.index({ 'provider_status.isOnline': 1 }); // Dla filtra availableNow
userSchema.index({ providerTier: 1 }); // Dla filtrowania po tier
userSchema.index({ verified: 1 }); // Dla filtra verified
userSchema.index({ b2b: 1 }); // Dla filtra B2B
userSchema.index({ services: 1 }); // Dla wyszukiwania po usługach
userSchema.index({ locationCoords: '2dsphere' }); // Dla geospatial queries (jeśli używasz)

module.exports = mongoose.models.User || mongoose.model('User', userSchema);