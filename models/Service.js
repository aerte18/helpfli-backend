const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  // Podstawowe informacje
  parent_slug: { type: String, required: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  name_pl: { type: String, required: true },
  name_en: { type: String, required: true },
  description: { type: String, required: true },
  
  // Wyszukiwanie i tagi
  tags: { type: String, default: '' },
  intent_keywords: { type: String, default: '' },
  
  // Bezpieczeństwo i pilność
  danger_flags: { type: String, default: '' },
  urgency_level: { type: Number, default: 3, min: 1, max: 5 },
  
  // Cennik
  base_price_min: { type: Number, default: 0 },
  base_price_max: { type: Number, default: 0 },
  unit: { type: String, default: 'PLN' },
  
  // Wymagania
  requires_photos: { type: Number, default: 0 },
  requires_address: { type: Number, default: 1 },
  requires_datetime: { type: Number, default: 1 },
  
  // AI i triage
  ai_triage_template: { type: String, default: '' },
  
  // Typ usługi
  service_kind: { type: String, enum: ['onsite', 'remote', 'hybrid'], default: 'onsite' },
  
  // Flagi specjalne
  is_top: { type: Number, default: 0 },
  seasonal: { type: String, enum: ['winter', 'spring', 'summer', 'autumn', 'none'], default: 'none' },
  
  // Metadane
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Indeksy dla wydajności
serviceSchema.index({ parent_slug: 1, is_top: -1 });
serviceSchema.index({ service_kind: 1 });
serviceSchema.index({ seasonal: 1 });
serviceSchema.index({ tags: 'text', intent_keywords: 'text', name_pl: 'text', name_en: 'text' });

module.exports = mongoose.model('Service', serviceSchema);
