const mongoose = require('mongoose');

const offerSchema = new mongoose.Schema({
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  price: Number,
  date: Date,
  note: String,
  level: { type: String, enum: ['basic', 'standard', 'pro'], default: 'basic' }, // poziom wykonawcy
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  // System wyróżniania ofert
  highlighted: { type: Boolean, default: false }, // Czy oferta jest wyróżniona
  highlightedUntil: { type: Date }, // Do kiedy oferta jest wyróżniona
  boostedAt: { type: Date }, // Data wyróżnienia
  boostPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }, // ID płatności za wyróżnienie
  boostFree: { type: Boolean, default: false } // Czy wyróżnienie było darmowe (z pakietu PRO)
});

const orderSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // dodane dla draftów wycen
  service: { type: String, required: true },
  serviceDetails: { type: String, default: '' }, // Doprecyzowanie usługi przez klienta (np. "wymiana rur")
  description: String,
  location: String,
  // Status workflow (ujednolicony z planem MVP)
  status: { 
    type: String, 
    enum: [
      'draft', // Legacy
      'open', // Nowe zlecenie
      'collecting_offers', // Zbiera oferty
      'accepted', // Oferta zaakceptowana
      'in_progress', // W trakcie realizacji
      'completed', // Zakończone
      'rated', // Ocenione
      'cancelled', // Anulowane
      // Legacy statusy (zachowane dla kompatybilności)
      'awaiting_payment', 'paid', 'matched', 'quote', 'funded', 'released', 'disputed'
    ], 
    default: 'draft',
    index: true
  },
  completedAt: { type: Date }, // Data zakończenia zlecenia
  deliveredOnTime: { type: Boolean, default: null }, // Czy zlecenie zostało ukończone na czas (null = nie określono)
  reviewReminderSent: { type: Boolean, default: false }, // Czy wysłano prośbę o recenzję
  // Pola zakończenia zlecenia
  completionType: { type: String, enum: ['simple', 'with_notes', 'with_payment'], default: null }, // Typ zakończenia: bez uwag, z uwagami, z dopłatą
  completionNotes: { type: String, default: null }, // Uwagi od wykonawcy przy zakończeniu
  additionalAmount: { type: Number, default: null }, // Kwota dopłaty (w PLN)
  paymentReason: { type: String, default: null }, // Uzasadnienie dopłaty
  // Email Marketing
  emailMarketing: {
    abandonedCartSent: { type: Boolean, default: false },
    abandonedCartSentAt: { type: Date }
  },
  paymentMethod: { type: String, enum: ['system', 'external'], default: 'system' },
  paymentPreference: { type: String, enum: ['system', 'external', 'both'], default: 'system' }, // Preferencje klienta: Helpfli Protect, płatność poza systemem, lub oba
  requestInvoice: { type: Boolean, default: false }, // Klient prosił o fakturę przy płatności
  priority: { type: String, enum: ['normal', 'priority'], default: 'normal' }, // Nowe pole - priorytet zlecenia
  priorityFee: { type: Number, default: 0 }, // Dopłata za priorytet (w groszach)
  priorityDateTime: { type: Date, default: null }, // Wybrana data i godzina dla priorytetowego zlecenia
  // MVP Fields - zgodnie z planem
  urgency: { 
    type: String, 
    enum: ['now', 'today', 'tomorrow', 'this_week', 'flexible'], // Pilność zlecenia
    default: 'flexible' 
  },
  urgencyTime: { type: String, default: null }, // Godzina dla pilności (format "HH:mm")
  
  budgetRange: {
    min: { type: Number, default: null },
    max: { type: Number, default: null }
  },
  budget: { type: Number, default: null }, // Budżet klienta (w PLN) - legacy
  
  preferredContact: {
    type: String,
    enum: ['chat', 'call', 'any'],
    default: 'chat'
  },
  contactPreference: { type: String, enum: ['phone', 'sms', 'email', 'chat', 'any'], default: null }, // Legacy
  
  matchMode: {
    type: String,
    enum: ['ai_suggested', 'manual_pick', 'open'],
    default: 'open'
  },
  
  // AI Triage result (cache)
  aiTriage: {
    severity: { type: String, enum: ['low', 'medium', 'high', 'urgent'] },
    suggestedService: String,
    selfFixSteps: [String],
    recommendedMode: { type: String, enum: ['now', 'today', 'flexible'] },
    priceRange: {
      min: Number,
      max: Number
    }
  },
  createdAt: { type: Date, default: Date.now },
  offers: [offerSchema], // ⬅️ kluczowa zmiana
  selectedOffer: { type: mongoose.Schema.Types.ObjectId }, // ID wybranej oferty (jeśli wybrano)
  acceptedOfferId: { type: mongoose.Schema.Types.ObjectId, ref: 'Offer' }, // ID zaakceptowanej oferty
  
  // Nowe pola Pakietu 2
  priceTotal: { type: Number, default: 0 },
  location: {
    lat: Number,
    lng: Number,
    address: String,
  },
  locationLat: { type: Number, default: null },
  locationLon: { type: Number, default: null },
  city: { type: String, default: '' },
  
  // Płatność/ochrona - NOWE POLA
  amountTotal: { type: Number, default: 0 }, // w groszach
  currency: { type: String, default: 'pln' },
  paidInSystem: { type: Boolean, default: false },
  paymentStatus: { type: String, enum: ['unpaid','processing','succeeded','failed','refunded','partial_refund'], default: 'unpaid' },
  paymentMethod: { type: String, enum: ['card','p24','blik','unknown'], default: 'unknown' },
  paymentProvider: { type: String, enum: ['stripe','none'], default: 'none' },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  
  // Gwarancja Helpfli
  protectionEligible: { type: Boolean, default: false },
  protectionStatus: { type: String, enum: ['inactive','active','expired','void'], default: 'inactive' },
  protectionExpiresAt: { type: Date, default: null },
  
  // Rozliczenia
  platformFeePercent: { type: Number, default: 0.07 }, // fallback gdy zmieni się ENV
  platformFeeAmount: { type: Number, default: 0 }, // w groszach
  
  payment: {
    status: { type: String, enum: ['requires_payment','paid','refunded','failed'], default: 'requires_payment' },
    method: { type: String },
    intentId: { type: String },
    protected: { type: Boolean, default: false }, // Gwarancja Helpfli tylko przy płatności w systemie
  },
  
  pricing: {
    baseAmount: { type: Number, default: 0 },
    extras: {
      express: { type: Boolean, default: false },
      guarantee: { type: Boolean, default: false },
      premiumProvider: { type: Boolean, default: false }
    },
    extrasCost: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    discountPromo: { type: Number, default: 0 },
    discountTier: { type: Number, default: 0 },
    discountPoints: { type: Number, default: 0 }, // Zniżka z punktów - pokrywana przez platformę
    total: { type: Number, default: 0 }, // Kwota którą płaci klient (po zniżkach)
    originalTotal: { type: Number, default: 0 }, // Kwota przed zniżką z punktów (dla rozliczeń z providerem)
    currency: { type: String, default: 'PLN' },
    appliedPromoCode: { type: String },
    pointsUsed: { type: Number, default: 0 }
  },
  
  // AI Concierge - NOWE POLA
  source: { type: String, enum: ['manual','ai'], default: 'manual' },
  priceQuotedMin: { type: Number, default: 0 }, // grosze
  priceQuotedMax: { type: Number, default: 0 }, // grosze
  invitedProviders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // opcjonalne zaproszenia z draftu
  
  // Sesja wideo (dla usług remote)
  videoSession: { type: mongoose.Schema.Types.ObjectId, ref: 'VideoSession', default: null },
  
  // Zaawansowane AI - FAZA 3
  aiTags: [{ type: String }], // Automatyczne tagi z AI (np. 'urgent', 'complex', 'repair')
  aiTagsConfidence: { type: Number, default: 0 }, // Pewność tagowania (0-1)
  aiTagsReasoning: { type: String, default: '' }, // Uzasadnienie tagów
  aiTaggedAt: { type: Date, default: null }, // Data tagowania
  
  // Integracje zewnętrzne - FAZA 3
  calendarEvents: [{ // Wydarzenia w kalendarzach zewnętrznych
    provider: { type: String, enum: ['google', 'outlook'] },
    eventId: { type: String },
    syncedAt: { type: Date }
  }],
  
  // Załączniki (zdjęcia, dokumenty)
  attachments: [{
    url: String,                // /uploads/orders/filename.ext
    type: String,               // image/jpeg, application/pdf, etc.
    filename: String,           // oryginalna nazwa pliku
    size: Number,               // rozmiar w bajtach
    uploadedAt: { type: Date, default: Date.now }
  }],

  // Faktura od providera do klienta
  invoice: {
    url: String,                // /uploads/orders/invoices/filename.pdf
    filename: String,           // oryginalna nazwa pliku
    size: Number,               // rozmiar w bajtach
    uploadedAt: { type: Date }, // data uploadu przez providera
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // provider który wrzucił fakturę
    sentToClient: { type: Boolean, default: false }, // czy wysłano maila do klienta
    sentAt: { type: Date } // data wysłania maila
  },

  // Spory i zwroty
  disputeStatus: { type: String, enum: ['none', 'reported', 'refund_requested', 'resolved', 'closed'], default: 'none' },
  disputeReason: { type: String, default: '' },
  disputeReportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  disputeReportedAt: { type: Date },
  refundRequested: { type: Boolean, default: false },
  refundRequestedAt: { type: Date },
  
  // System wygasania zleceń
  expiresAt: { type: Date, index: true }, // Data wygaśnięcia zlecenia (gdy status = 'open' lub 'collecting_offers')
  originalExpiresAt: { type: Date }, // Oryginalna data wygaśnięcia (przed wydłużeniami)
  extendedCount: { type: Number, default: 0 }, // Ile razy było wydłużane
  autoExtended: { type: Boolean, default: false }, // Czy było automatycznie wydłużone przez AI
  lastExtendedAt: { type: Date }, // Data ostatniego wydłużenia
  extensionReason: { type: String, default: '' }, // Powód ostatniego wydłużenia (dla AI/manual)
  
  // System podbijania zleceń
  boostedAt: { type: Date }, // Data ostatniego podbicia
  boostedUntil: { type: Date, index: true }, // Do kiedy zlecenie jest podbite (na górze listy)
  lastBoostedAt: { type: Date }, // Data ostatniego podbicia (dla historii)
  boostCount: { type: Number, default: 0 }, // Ile razy było podbite
  boostPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }, // ID płatności za ostatnie podbicie
  boostFree: { type: Boolean, default: false }, // Czy podbicie było darmowe (z pakietu PRO)
  
  // Teleporada - pola dla konsultacji online
  isTeleconsultation: { type: Boolean, default: false }, // Czy to teleporada
  scheduledDateTime: { type: Date }, // Zaplanowany termin konsultacji (ustawiany po akceptacji oferty)
  consultationType: { type: String, enum: ['video', 'phone', 'chat', 'email', null], default: null }, // Typ połączenia: przez stronę (video), telefon, chat lub email
  consultationDuration: { type: Number, default: 30 }, // Czas trwania konsultacji w minutach (30, 60, etc.)
  consultationLink: { type: String, default: null }, // Link do połączenia video (generowany po akceptacji)
  consultationPhone: { type: String, default: null }, // Numer telefonu do połączenia (jeśli consultationType = 'phone')
  
  // Usługi z dostawą (delivery)
  deliveryAddress: { type: String, default: null }, // Adres dostawy (jeśli różny od location)
  deliveryMethod: { type: String, enum: ['pickup', 'courier', 'post', 'self', null], default: null }, // Metoda dostawy: odbiór, kurier, poczta, odbiór osobisty
  deliveryStatus: { type: String, enum: ['pending', 'preparing', 'ready', 'shipped', 'in_transit', 'delivered', 'failed', null], default: null }, // Status dostawy
  deliveryTrackingNumber: { type: String, default: null }, // Numer śledzenia przesyłki
  deliveryEstimatedDate: { type: Date, default: null }, // Szacowana data dostawy
  deliveryCompletedAt: { type: Date, default: null }, // Data dostarczenia
  
  // Usługi abonamentowe (subscription)
  isSubscription: { type: Boolean, default: false }, // Czy to usługa abonamentowa
  subscriptionType: { type: String, enum: ['weekly', 'biweekly', 'monthly', 'custom', null], default: null }, // Typ abonamentu: tygodniowy, dwutygodniowy, miesięczny, niestandardowy
  subscriptionFrequency: { type: Number, default: null }, // Częstotliwość (w dniach) - dla custom
  subscriptionStartDate: { type: Date, default: null }, // Data rozpoczęcia abonamentu
  subscriptionEndDate: { type: Date, default: null }, // Data zakończenia abonamentu (opcjonalna)
  subscriptionTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null } // ID template order (dla zleceń utworzonych przez cron - link do template)
});

// Indexes to speed up dashboards and filtering
orderSchema.index({ client: 1, createdAt: -1 });
orderSchema.index({ provider: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ service: 1 });
orderSchema.index({ acceptedOfferId: 1 });
// expiresAt ma już index: true w definicji pola, więc nie dodajemy tutaj duplikatu
// Geo index dla location search
if (orderSchema.path('location.lat') && orderSchema.path('location.lng')) {
  orderSchema.index({ 'location.lat': 1, 'location.lng': 1 });
}

module.exports = mongoose.model('Order', orderSchema);