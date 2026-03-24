const mongoose = require('mongoose');

const CompanyWorkflowSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  
  // Włączone funkcje workflow
  enabled: { type: Boolean, default: true },
  
  // Reguły routingu zleceń
  routingRules: {
    // Strategia routingu
    strategy: {
      type: String,
      enum: ['round_robin', 'location_based', 'specialization_based', 'availability_based', 'priority_based', 'manual', 'hybrid'],
      default: 'round_robin'
    },
    
    // Round-robin: równomierne rozłożenie zleceń
    roundRobin: {
      enabled: { type: Boolean, default: true },
      lastAssignedIndex: { type: Number, default: -1 } // Indeks ostatnio przypisanego providera
    },
    
    // Location-based: przypisanie na podstawie lokalizacji
    locationBased: {
      enabled: { type: Boolean, default: false },
      maxDistance: { type: Number, default: 50 }, // Maksymalna odległość w km
      preferClosest: { type: Boolean, default: true } // Czy preferować najbliższych
    },
    
    // Specialization-based: przypisanie na podstawie specjalizacji/usług
    specializationBased: {
      enabled: { type: Boolean, default: false },
      matchServices: { type: Boolean, default: true }, // Dopasowanie po usługach
      matchCategories: { type: Boolean, default: true }, // Dopasowanie po kategoriach
      requireExactMatch: { type: Boolean, default: false } // Czy wymagać dokładnego dopasowania
    },
    
    // Availability-based: przypisanie na podstawie dostępności
    availabilityBased: {
      enabled: { type: Boolean, default: false },
      checkOnlineStatus: { type: Boolean, default: true }, // Sprawdź status online
      checkSchedule: { type: Boolean, default: true }, // Sprawdź harmonogram
      preferAvailableNow: { type: Boolean, default: true } // Czy preferować dostępnych teraz
    },
    
    // Priority-based: przypisanie na podstawie priorytetu członka
    priorityBased: {
      enabled: { type: Boolean, default: false },
      priorityMembers: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        priority: { type: Number, default: 1 }, // Wyższa liczba = wyższy priorytet
        weight: { type: Number, default: 1.0 } // Waga w algorytmie (0.0 - 2.0)
      }]
    },
    
    // Hybrid: kombinacja wielu strategii
    hybrid: {
      enabled: { type: Boolean, default: false },
      strategies: [{
        strategy: { type: String, enum: ['round_robin', 'location_based', 'specialization_based', 'availability_based', 'priority_based'] },
        weight: { type: Number, default: 1.0 } // Waga strategii (0.0 - 1.0)
      }],
      scoringMethod: {
        type: String,
        enum: ['weighted_sum', 'weighted_product', 'threshold'],
        default: 'weighted_sum'
      }
    },
    
    // Manual: ręczne przypisanie (wyłączone automatyczne przypisanie)
    manual: {
      enabled: { type: Boolean, default: false },
      requireApproval: { type: Boolean, default: true }, // Czy wymagać zatwierdzenia przez managera
      notifyManagers: { type: Boolean, default: true } // Czy powiadamiać managerów o nowych zleceniach
    },
    
    // Ogólne ustawienia
    settings: {
      autoAssign: { type: Boolean, default: true }, // Automatyczne przypisanie
      assignTimeout: { type: Number, default: 300 }, // Timeout w sekundach (5 minut)
      maxAssignAttempts: { type: Number, default: 3 }, // Maksymalna liczba prób przypisania
      fallbackToManual: { type: Boolean, default: true }, // Fallback do ręcznego przypisania jeśli automatyczne nie działa
      notifyOnAssignment: { type: Boolean, default: true }, // Powiadomienia o przypisaniu
      notifyOnFailure: { type: Boolean, default: true } // Powiadomienia o niepowodzeniu przypisania
    }
  },
  
  // Szablony odpowiedzi firmowych
  responseTemplates: [{
    name: { type: String, required: true },
    subject: { type: String },
    message: { type: String, required: true },
    triggerConditions: {
      serviceCategory: { type: String }, // Kategoria usługi
      orderUrgency: { type: String, enum: ['normal', 'today', 'now'] }, // Pilność zlecenia
      orderBudget: { min: { type: Number }, max: { type: Number } }, // Budżet zlecenia
      location: { type: String } // Lokalizacja
    },
    isDefault: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }],
  
  // Automatyczne eskalacje
  escalations: [{
    name: { type: String, required: true },
    trigger: {
      type: {
        type: String,
        enum: ['no_response', 'timeout', 'rejection', 'low_rating', 'custom'],
        required: true
      },
      timeout: { type: Number }, // Timeout w godzinach
      conditions: { type: mongoose.Schema.Types.Mixed } // Dodatkowe warunki
    },
    action: {
      type: {
        type: String,
        enum: ['reassign', 'notify_manager', 'notify_owner', 'escalate_to_manager', 'cancel_order'],
        required: true
      },
      targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Docelowy użytkownik (dla reassign)
      notifyUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // Użytkownicy do powiadomienia
    },
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
  }],
  
  // Statystyki workflow
  stats: {
    totalAssignments: { type: Number, default: 0 },
    successfulAssignments: { type: Number, default: 0 },
    failedAssignments: { type: Number, default: 0 },
    averageAssignmentTime: { type: Number, default: 0 }, // W sekundach
    lastAssignmentAt: { type: Date }
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indeksy
CompanyWorkflowSchema.index({ company: 1 });
CompanyWorkflowSchema.index({ enabled: 1 });

// Pre-save middleware
CompanyWorkflowSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Metody instancji
CompanyWorkflowSchema.methods.getRoutingStrategy = function() {
  return this.routingRules.strategy;
};

CompanyWorkflowSchema.methods.isAutoAssignEnabled = function() {
  return this.enabled && this.routingRules.settings.autoAssign;
};

CompanyWorkflowSchema.methods.getResponseTemplate = function(order) {
  // Znajdź odpowiedni szablon na podstawie warunków zlecenia
  const templates = this.responseTemplates.filter(t => {
    if (t.triggerConditions.serviceCategory && order.service !== t.triggerConditions.serviceCategory) {
      return false;
    }
    if (t.triggerConditions.orderUrgency && order.urgency !== t.triggerConditions.orderUrgency) {
      return false;
    }
    if (t.triggerConditions.orderBudget) {
      const budget = order.budget || 0;
      if (t.triggerConditions.orderBudget.min && budget < t.triggerConditions.orderBudget.min) {
        return false;
      }
      if (t.triggerConditions.orderBudget.max && budget > t.triggerConditions.orderBudget.max) {
        return false;
      }
    }
    return true;
  });
  
  // Zwróć pierwszy pasujący szablon lub domyślny
  return templates.find(t => t.isDefault) || templates[0] || null;
};

module.exports = mongoose.model('CompanyWorkflow', CompanyWorkflowSchema);







