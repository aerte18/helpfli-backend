const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  url: String,                // /uploads/drafts/filename.ext
  type: { type: String, enum: ['image','video','other'], default: 'image' },
  filename: String,
  size: Number,
  uploadedAt: { type: Date, default: Date.now }
}, { _id: true });

const StepSchema = new mongoose.Schema({
  text: String,
  done: { type: Boolean, default: false }
}, { _id: false });

const OrderDraftSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  description: { type: String, required: true },

  serviceCandidate: { code: String, name: String, score: { type: Number, default: 0 } },
  extraCandidates: [{ code: String, name: String, score: Number }],

  location: { text: String, lat: Number, lon: Number },

  priceHints: {
    basic: { min: Number, max: Number },
    standard: { min: Number, max: Number },
    pro: { min: Number, max: Number }
  },

  selfHelp: [String],
  recommendedProviders: [{
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String, level: { type: String, enum: ['basic','standard','pro'], default: 'standard' },
    rating: { type: Number, default: 0 }, distanceKm: { type: Number, default: null }
  }],

  urgency: { type: String, enum: ['now','today','tomorrow','flex'], default: 'flex' },

  // NOWE:
  attachments: { type: [AttachmentSchema], default: [] },
  status: { type: String, enum: ['draft','submitted','expired'], default: 'draft' },
  expiresAt: { type: Date, default: null },
  
  // AI enhancements:
  language: { type: String, enum: ['pl','en'], default: 'pl' },
  dangerFlags: { type: [String], default: [] },     // np. ['electricity','gas']
  diySteps: { type: [StepSchema], default: [] },     // lista kroków z checkboxami
  parts: [{ name: String, qty: Number, approxPrice: Number, unit: String }] // części do kupienia
}, { timestamps: true });

// TTL (opcjonalnie): 30 dni dla draftów z expiresAt
OrderDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OrderDraft', OrderDraftSchema);
