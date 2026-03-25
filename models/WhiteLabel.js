// Model dla white-label (własne brandingi, domeny, customizacja UI)
const mongoose = require('mongoose');

const whiteLabelSchema = new mongoose.Schema({
  // Właściciel white-label (firma lub użytkownik)
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  
  // Nazwa white-label
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true },
  
  // Status
  status: { 
    type: String, 
    enum: ['pending', 'active', 'suspended', 'expired'], 
    default: 'pending' 
  },
  isActive: { type: Boolean, default: false },
  
  // Branding
  branding: {
    // Logo
    logo: { type: String }, // URL do logo
    logoDark: { type: String }, // Logo dla trybu ciemnego
    favicon: { type: String }, // Favicon
    
    // Kolory
    primaryColor: { type: String, default: '#3B82F6' }, // Główny kolor
    secondaryColor: { type: String, default: '#10B981' }, // Drugi kolor
    accentColor: { type: String, default: '#F59E0B' }, // Kolor akcentu
    backgroundColor: { type: String, default: '#FFFFFF' }, // Tło
    textColor: { type: String, default: '#1F2937' }, // Kolor tekstu
    
    // Typografia
    fontFamily: { type: String, default: 'Inter' },
    headingFont: { type: String, default: 'Inter' },
    
    // Nazwa marki
    brandName: { type: String }, // Jeśli różna od Helpfli
    tagline: { type: String }, // Slogan
  },
  
  // Domeny
  domains: [{
    domain: { type: String, required: true }, // np. "moja-firma.pl"
    isPrimary: { type: Boolean, default: false },
    sslEnabled: { type: Boolean, default: false },
    sslCertificate: { type: String }, // Certyfikat SSL
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date }
  }],
  
  // Customizacja UI
  ui: {
    // Layout
    layout: {
      headerStyle: { type: String, enum: ['default', 'minimal', 'centered'], default: 'default' },
      footerStyle: { type: String, enum: ['default', 'minimal', 'extended'], default: 'default' },
      sidebarPosition: { type: String, enum: ['left', 'right', 'none'], default: 'left' }
    },
    
    // Komponenty
    components: {
      showSearchBar: { type: Boolean, default: true },
      showNotifications: { type: Boolean, default: true },
      showUserMenu: { type: Boolean, default: true },
      showLanguageSwitcher: { type: Boolean, default: true }
    },
    
    // Strony
    pages: {
      homepage: {
        heroTitle: { type: String },
        heroSubtitle: { type: String },
        heroImage: { type: String },
        showFeatures: { type: Boolean, default: true },
        showTestimonials: { type: Boolean, default: true }
      },
      about: {
        enabled: { type: Boolean, default: false },
        content: { type: String }
      },
      contact: {
        enabled: { type: Boolean, default: false },
        email: { type: String },
        phone: { type: String },
        address: { type: String }
      }
    },
    
    // Custom CSS
    customCss: { type: String }, // Dodatkowy CSS
    customJs: { type: String } // Dodatkowy JavaScript
  },
  
  // Subskrypcja
  subscription: {
    plan: { type: String, enum: ['basic', 'standard', 'premium'], default: 'basic' },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: false }
  },
  
  // Statystyki
  stats: {
    totalVisits: { type: Number, default: 0 },
    uniqueVisitors: { type: Number, default: 0 },
    lastVisitAt: { type: Date }
  },
  
  // Metadane
  metadata: { type: Object, default: {} },
  notes: { type: String }
}, {
  timestamps: true
});

// Indeksy
whiteLabelSchema.index({ slug: 1 }, { unique: true });
whiteLabelSchema.index({ owner: 1 });
whiteLabelSchema.index({ company: 1 });
whiteLabelSchema.index({ status: 1, isActive: 1 });
whiteLabelSchema.index({ 'domains.domain': 1 });

// Metody
whiteLabelSchema.methods.getPrimaryDomain = function() {
  const primary = this.domains.find(d => d.isPrimary);
  return primary ? primary.domain : null;
};

whiteLabelSchema.methods.addDomain = function(domain, isPrimary = false) {
  if (isPrimary) {
    // Usuń primary z innych domen
    this.domains.forEach(d => d.isPrimary = false);
  }
  
  this.domains.push({
    domain,
    isPrimary,
    verified: false
  });
  
  return this.save();
};

whiteLabelSchema.methods.verifyDomain = function(domain) {
  const domainObj = this.domains.find(d => d.domain === domain);
  if (domainObj) {
    domainObj.verified = true;
    domainObj.verifiedAt = new Date();
    return this.save();
  }
  throw new Error('Domena nie znaleziona');
};

module.exports = mongoose.model('WhiteLabel', whiteLabelSchema);













