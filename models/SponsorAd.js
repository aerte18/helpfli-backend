const mongoose = require('mongoose');

/**
 * Model reklam kontekstowych/sponsorowanych
 * Firmy płacą za wyświetlanie reklam w odpowiedziach AI Concierge
 * Przykład: "Zepsuła się pralka" → AI poleca sklep z częściami AGD
 */
const SponsorAdSchema = new mongoose.Schema({
  // Firma zewnętrzna (może być niezalogowana)
  advertiser: {
    companyName: { type: String, required: true },
    email: { type: String, required: true },
    phone: String,
    website: String,
    nip: String, // Dla faktur
    address: {
      street: String,
      city: String,
      postalCode: String,
      country: { type: String, default: 'Polska' }
    }
  },
  
  // Typ reklamy
  adType: {
    type: String,
    enum: ['parts_store', 'equipment_rental', 'tool_rental', 'service_provider', 'supplier', 'other'],
    required: true
  },
  
  // Tytuł i opis reklamy
  title: { type: String, required: true, maxlength: 100 },
  description: { type: String, required: true, maxlength: 500 },
  
  // Słowa kluczowe - kiedy pokazywać reklamę
  keywords: [{ type: String }], // np. ["pralka", "AGD", "części", "naprawa"]
  
  // Kategorie usług - kiedy pokazywać
  serviceCategories: [{ type: String }], // np. ["hydraulik", "elektryk", "AGD"]
  
  // Typy zleceń - kiedy pokazywać
  orderTypes: [{ type: String }], // np. ["repair", "installation", "maintenance"]
  
  // Lokalizacja (opcjonalne - jeśli puste, pokazuje się wszędzie)
  locations: [{
    city: String,
    district: String, // Dzielnica (tylko Enterprise)
    voivodeship: String, // Województwo (Premium, Enterprise)
    lat: Number, // Szerokość geograficzna (dla radius targeting)
    lon: Number, // Długość geograficzna (dla radius targeting)
    radius: Number // promień w km (opcjonalne, tylko Enterprise)
  }],
  
  // Geotargeting settings
  geotargeting: {
    enabled: { type: Boolean, default: false },
    type: { 
      type: String, 
      enum: ['country', 'voivodeship', 'city', 'district', 'radius'], 
      default: 'country' 
    }, // Typ geotargetingu
    voivodeships: [{ type: String }], // Lista województw (Premium, Enterprise)
    cities: [{ type: String }], // Lista miast (Enterprise)
    districts: [{ type: String }], // Lista dzielnic (Enterprise)
    radiusTargets: [{ // Radius targeting (Enterprise)
      lat: Number,
      lon: Number,
      radius: Number // w km
    }]
  },
  
  // Link i CTA
  link: { type: String, required: true }, // URL do strony firmy
  ctaText: { type: String, default: 'Sprawdź ofertę' },
  
  // Obrazy/logo/wideo
  imageUrl: String, // Główny obraz reklamy (może być GIF animowany)
  logoUrl: String, // Logo firmy
  videoUrl: String, // URL do wideo (opcjonalnie)
  mediaType: {
    type: String,
    enum: ['image', 'gif', 'video', 'html5'], // Typ mediów
    default: 'image'
  },
  htmlContent: String, // HTML5 reklama (dla zaawansowanych)
  
  // Szczegóły dla różnych typów reklam
  details: {
    // Dla sklepów z częściami
    partsStore: {
      categories: [{ type: String }], // np. ["AGD", "elektronika", "hydraulika"]
      deliveryAvailable: { type: Boolean, default: false },
      deliveryPrice: Number, // w groszach
      pickupAvailable: { type: Boolean, default: true }
    },
    // Dla wypożyczalni narzędzi
    equipmentRental: {
      equipmentTypes: [{ type: String }], // np. ["betoniarka", "wiertarka", "szlifierka"]
      minRentalDays: { type: Number, default: 1 },
      deliveryAvailable: { type: Boolean, default: false },
      operatorAvailable: { type: Boolean, default: false }
    },
    // Dla dostawców materiałów
    supplier: {
      materials: [{ type: String }], // np. ["cement", "płyty gipsowe", "farby"]
      bulkOrders: { type: Boolean, default: false },
      minOrderValue: Number // w groszach
    }
  },
  
  // Status i moderacja
  status: {
    type: String,
    enum: ['pending', 'active', 'paused', 'expired', 'rejected'],
    default: 'pending'
  },
  
  moderation: {
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: String,
    notes: String
  },
  
  // Płatności i kampania
  campaign: {
    budget: { type: Number, required: true }, // budżet w groszach
    spent: { type: Number, default: 0 }, // wydane w groszach
    pricingModel: {
      type: String,
      enum: ['cpc', 'cpm', 'cpa', 'flat', 'package', 'auction'], // cost per click, impression, action, flat rate, package, auction
      default: 'cpc'
    },
    
    // Dynamiczne ceny (aukcje)
    auction: {
      enabled: { type: Boolean, default: false },
      displayLocation: String, // Pozycja reklamowa (np. 'landing_page_banner')
      currentBid: { type: Number, default: 0 }, // Aktualna oferta w groszach
      minBid: { type: Number, default: 0 }, // Minimalna oferta w groszach
      bidIncrement: { type: Number, default: 1000 }, // Minimalny przyrost oferty (w groszach)
      auctionEndDate: Date, // Data zakończenia aukcji
      bidders: [{ // Uczestnicy aukcji
        advertiserEmail: String,
        bidAmount: Number, // W groszach
        bidDate: Date
      }],
      winner: { // Zwycięzca aukcji
        advertiserEmail: String,
        bidAmount: Number,
        wonAt: Date
      }
    },
    pricePerClick: Number, // w groszach (dla CPC)
    pricePerImpression: Number, // w groszach (dla CPM)
    pricePerAction: Number, // w groszach (dla CPA)
    flatRate: Number, // w groszach (dla flat rate)
    
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    
    dailyBudget: Number, // maksymalny dzienny budżet w groszach
    maxImpressions: Number, // maksymalna liczba wyświetleń
    maxClicks: Number, // maksymalna liczba kliknięć
    notificationSent: { type: Boolean, default: false }, // czy wysłano powiadomienie o końcu
    autoRenew: { type: Boolean, default: false }, // automatyczne przedłużanie kampanii
    renewalPeriod: { type: Number, default: 30 }, // okres przedłużenia w dniach (domyślnie 30)
    renewalCount: { type: Number, default: 0 }, // liczba przedłużeń
    // Long-term discounts
    subscriptionMonths: { type: Number, default: 1 }, // Liczba miesięcy subskrypcji (1, 3, 6, 12)
    discountApplied: { type: Number, default: 0 }, // Zastosowana zniżka w % (0-25)
    originalPrice: Number // Oryginalna cena przed zniżką (w groszach)
  },
  
  // Informacje o płatności
  payment: {
    paymentIntentId: String,
    amount: Number, // w groszach
    currency: { type: String, default: 'pln' },
    paidAt: Date,
    status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' }
  },
  
  // Statystyki
  stats: {
    impressions: { type: Number, default: 0 }, // wyświetlenia
    clicks: { type: Number, default: 0 }, // kliknięcia
    conversions: { type: Number, default: 0 }, // konwersje (np. zakupy, zapytania)
    ctr: { type: Number, default: 0 }, // click-through rate (%)
    avgPosition: { type: Number, default: 0 }, // średnia pozycja w odpowiedzi AI (1-5)
    conversionRate: { type: Number, default: 0 } // conversion rate (%) - konwersje / kliknięcia
  },
  
  // Priorytet (wyższy = częściej pokazywane)
  priority: { type: Number, default: 0 },
  
  // Freemium - darmowa próba
  freeTrial: {
    isFreeTrial: { type: Boolean, default: false },
    trialStartDate: Date,
    trialEndDate: Date,
    trialImpressionsLimit: { type: Number, default: 100 }, // Limit wyświetleń dla próby
    trialImpressionsUsed: { type: Number, default: 0 },
    convertedToPackage: { type: Boolean, default: false }, // Czy firma wykupiła pakiet po próbie
    conversionOfferSent: { type: Boolean, default: false } // Czy wysłano ofertę konwersji
  },
  
  // A/B Testing
  abTest: {
    isActive: { type: Boolean, default: false },
    variants: [{
      variant: { type: String, enum: ['A', 'B', 'C'], required: true },
      title: String, // Różny tytuł dla wariantu
      description: String, // Różny opis dla wariantu
      imageUrl: String, // Różny obraz dla wariantu
      ctaText: String, // Różny CTA dla wariantu
      stats: {
        impressions: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        conversions: { type: Number, default: 0 },
        ctr: { type: Number, default: 0 },
        conversionRate: { type: Number, default: 0 }
      }
    }],
    currentVariant: { type: String, enum: ['A', 'B', 'C'] }, // Aktualnie wyświetlany wariant
    testStartDate: Date,
    testEndDate: Date,
    minImpressions: { type: Number, default: 1000 }, // Minimalna liczba wyświetleń przed wyborem zwycięzcy
    winner: { type: String, enum: ['A', 'B', 'C'] }, // Zwycięski wariant (ustawiany automatycznie)
    autoSelectWinner: { type: Boolean, default: true } // Automatycznie wybierz najlepszy wariant
  },
  
  // Gdzie wyświetlać reklamę (pozycje reklamowe)
  displayLocations: [{
    type: String,
    enum: [
      'landing_page_banner', // Banner na stronie głównej
      'ai_concierge', // Polecanie w AI
      'search_results', // Sidebar w wyszukiwaniu (Home)
      'order_details', // Sidebar w szczegółach zlecenia
      'between_items', // Między zleceniami (co 3)
      'provider_list', // Lista wykonawców
      'my_orders', // Moje zlecenia
      'available_orders' // Dostępne zlecenia
    ]
  }],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indeksy dla szybkiego wyszukiwania
SponsorAdSchema.index({ status: 1, 'campaign.startDate': 1, 'campaign.endDate': 1 });
SponsorAdSchema.index({ keywords: 1 });
SponsorAdSchema.index({ serviceCategories: 1 });
SponsorAdSchema.index({ adType: 1, status: 1 });
SponsorAdSchema.index({ priority: -1 });

// Auto-update updatedAt
SponsorAdSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Metoda do sprawdzania czy reklama jest aktywna
SponsorAdSchema.methods.isActive = function() {
  const now = new Date();
  
  if (this.status !== 'active') return false;
  
  // Sprawdź darmową próbę
  if (this.freeTrial?.isFreeTrial) {
    return this.freeTrial.trialEndDate >= now &&
           this.freeTrial.trialImpressionsUsed < this.freeTrial.trialImpressionsLimit &&
           !this.freeTrial.convertedToPackage;
  }
  
  // Normalna reklama
  return this.campaign.startDate <= now &&
         this.campaign.endDate >= now &&
         this.campaign.spent < this.campaign.budget;
};

// Metoda do sprawdzania dopasowania do kontekstu
SponsorAdSchema.methods.matchesContext = function(context) {
  const { keywords, serviceCategory, orderType, location } = context;
  
  // Sprawdź słowa kluczowe
  if (keywords && this.keywords.length > 0) {
    const matchesKeywords = keywords.some(kw => 
      this.keywords.some(adKw => 
        kw.toLowerCase().includes(adKw.toLowerCase()) || 
        adKw.toLowerCase().includes(kw.toLowerCase())
      )
    );
    if (!matchesKeywords) return false;
  }
  
  // Sprawdź kategorię usługi
  if (serviceCategory && this.serviceCategories.length > 0) {
    if (!this.serviceCategories.includes(serviceCategory)) return false;
  }
  
  // Sprawdź typ zlecenia
  if (orderType && this.orderTypes.length > 0) {
    if (!this.orderTypes.includes(orderType)) return false;
  }
  
  // Sprawdź lokalizację (jeśli określona)
  if (location && this.locations.length > 0) {
    const matchesLocation = this.locations.some(loc => {
      if (loc.city && location.city) {
        return loc.city.toLowerCase() === location.city.toLowerCase();
      }
      return true; // Jeśli nie określono miasta, pokazuj wszędzie
    });
    if (!matchesLocation) return false;
  }
  
  return true;
};

module.exports = mongoose.model('SponsorAd', SponsorAdSchema);

