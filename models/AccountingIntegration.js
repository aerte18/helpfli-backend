// Model dla integracji z systemami księgowymi
const mongoose = require('mongoose');

const accountingIntegrationSchema = new mongoose.Schema({
  // Użytkownik/firma, która ma integrację
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  
  // Typ systemu księgowego
  provider: { 
    type: String, 
    enum: ['wfirma', 'enova', 'comarch', 'sage', 'xero', 'quickbooks', 'custom'], 
    required: true 
  },
  
  // Status integracji
  status: { 
    type: String, 
    enum: ['pending', 'active', 'error', 'disabled'], 
    default: 'pending' 
  },
  isActive: { type: Boolean, default: false },
  
  // Dane autoryzacji
  credentials: {
    // wFirma
    apiKey: { type: String },
    apiSecret: { type: String },
    
    // Enova
    username: { type: String },
    password: { type: String },
    companyId: { type: String },
    
    // Comarch
    apiKey: { type: String },
    apiUrl: { type: String },
    
    // Sage/Xero/QuickBooks (OAuth)
    accessToken: { type: String },
    refreshToken: { type: String },
    tenantId: { type: String },
    
    // Custom
    endpoint: { type: String },
    apiKey: { type: String },
    apiSecret: { type: String }
  },
  
  // Konfiguracja synchronizacji
  syncConfig: {
    // Co synchronizować
    syncInvoices: { type: Boolean, default: true },
    syncPayments: { type: Boolean, default: true },
    syncExpenses: { type: Boolean, default: false },
    
    // Automatyczna synchronizacja
    autoSync: { type: Boolean, default: true },
    syncInterval: { type: Number, default: 3600000 }, // 1 godzina
    
    // Mapowanie kont księgowych
    accountMapping: {
      revenue: { type: String }, // Konto przychodów
      expenses: { type: String }, // Konto kosztów
      platformFee: { type: String }, // Konto opłat platformowych
      vat: { type: String } // Konto VAT
    },
    
    // Ostatnia synchronizacja
    lastSyncAt: { type: Date },
    lastSyncStatus: { type: String, enum: ['success', 'error', 'partial'] },
    lastSyncError: { type: String }
  },
  
  // Statystyki
  stats: {
    totalSynced: { type: Number, default: 0 },
    invoicesSynced: { type: Number, default: 0 },
    paymentsSynced: { type: Number, default: 0 },
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
accountingIntegrationSchema.index({ user: 1, provider: 1 }, { unique: true });
accountingIntegrationSchema.index({ company: 1, provider: 1 });
accountingIntegrationSchema.index({ status: 1, isActive: 1 });

module.exports = mongoose.model('AccountingIntegration', accountingIntegrationSchema);













