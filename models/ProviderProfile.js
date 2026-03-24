const mongoose = require('mongoose');

const providerProfileSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    unique: true 
  },
  
  // Geo
  location: {
    type: { 
      type: String, 
      enum: ['Point'], 
      default: 'Point' 
    },
    coordinates: { 
      type: [Number], 
      required: true 
    } // [lng, lat] - MongoDB format
  },
  address: String,
  city: String,
  postalCode: String,
  radius: { type: Number, default: 50 }, // km
  
  // Availability
  availabilityNow: { type: Boolean, default: false, index: true },
  availabilitySchedule: {
    monday: { start: String, end: String, available: Boolean },
    tuesday: { start: String, end: String, available: Boolean },
    wednesday: { start: String, end: String, available: Boolean },
    thursday: { start: String, end: String, available: Boolean },
    friday: { start: String, end: String, available: Boolean },
    saturday: { start: String, end: String, available: Boolean },
    sunday: { start: String, end: String, available: Boolean }
  },
  
  // Services
  services: [{ 
    code: String, // 'hydraulik', 'elektryk', etc.
    name: String,
    priceRange: { 
      min: Number, 
      max: Number 
    }
  }],
  
  // Stats
  avgRating: { type: Number, default: 0, index: true },
  jobsDone: { type: Number, default: 0 },
  responseTime: Number, // średni czas odpowiedzi w minutach
  
  // Meta
  bio: String,
  experienceYears: Number,
  certifications: [String],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// WAŻNE: Indeksy geo (2dsphere)
providerProfileSchema.index({ location: '2dsphere' });
providerProfileSchema.index({ userId: 1 });
providerProfileSchema.index({ 'services.code': 1 });
providerProfileSchema.index({ availabilityNow: 1 });
providerProfileSchema.index({ avgRating: -1 });

// Auto-update updatedAt
providerProfileSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ProviderProfile', providerProfileSchema);

