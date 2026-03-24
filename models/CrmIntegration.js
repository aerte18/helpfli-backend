// Model dla integracji CRM (Salesforce, HubSpot, etc.)
const mongoose = require('mongoose');

const crmIntegrationSchema = new mongoose.Schema({
  // Użytkownik/firma, która ma integrację
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null }, // Opcjonalnie dla firm
  
  // Typ CRM
  provider: { 
    type: String, 
    enum: ['salesforce', 'hubspot', 'pipedrive', 'zoho', 'custom'], 
    required: true 
  },
  
  // Status integracji
  status: { 
    type: String, 
    enum: ['pending', 'active', 'error', 'disabled'], 
    default: 'pending' 
  },
  isActive: { type: Boolean, default: false },
  
  // Dane autoryzacji (różne dla różnych CRM)
  credentials: {
    // Salesforce
    accessToken: { type: String },
    refreshToken: { type: String },
    instanceUrl: { type: String }, // Salesforce instance URL
    clientId: { type: String },
    clientSecret: { type: String },
    
    // HubSpot
    apiKey: { type: String },
    portalId: { type: String },
    
    // Pipedrive
    apiToken: { type: String },
    
    // Custom/Generic
    endpoint: { type: String },
    apiKey: { type: String },
    apiSecret: { type: String }
  },
  
  // Konfiguracja synchronizacji
  syncConfig: {
    // Co synchronizować
    syncOrders: { type: Boolean, default: true },
    syncProviders: { type: Boolean, default: false },
    syncPayments: { type: Boolean, default: true },
    syncRatings: { type: Boolean, default: false },
    
    // Mapowanie pól
    fieldMapping: {
      // Mapowanie zleceń na obiekty CRM
      orderToContact: { type: Object, default: {} },
      orderToDeal: { type: Object, default: {} },
      orderToTask: { type: Object, default: {} }
    },
    
    // Automatyczna synchronizacja
    autoSync: { type: Boolean, default: true },
    syncInterval: { type: Number, default: 300000 }, // 5 minut w ms
    
    // Ostatnia synchronizacja
    lastSyncAt: { type: Date },
    lastSyncStatus: { type: String, enum: ['success', 'error', 'partial'] },
    lastSyncError: { type: String }
  },
  
  // Statystyki
  stats: {
    totalSynced: { type: Number, default: 0 },
    ordersSynced: { type: Number, default: 0 },
    contactsSynced: { type: Number, default: 0 },
    dealsSynced: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
    lastSyncAt: { type: Date }
  },
  
  // Metadane
  metadata: { type: Object, default: {} },
  notes: { type: String }
}, {
  timestamps: true
});

// Indeksy
crmIntegrationSchema.index({ user: 1, provider: 1 }, { unique: true });
crmIntegrationSchema.index({ company: 1, provider: 1 });
crmIntegrationSchema.index({ status: 1, isActive: 1 });

module.exports = mongoose.model('CrmIntegration', crmIntegrationSchema);













