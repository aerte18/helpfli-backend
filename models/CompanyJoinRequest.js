const mongoose = require('mongoose');

const companyJoinRequestSchema = new mongoose.Schema({
  company: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Company', 
    required: true,
    index: true
  },
  provider: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  message: { 
    type: String,
    maxlength: 500
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedAt: {
    type: Date
  },
  rejectionReason: {
    type: String,
    maxlength: 500
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indeksy dla wydajności
companyJoinRequestSchema.index({ company: 1, status: 1 });
companyJoinRequestSchema.index({ provider: 1, status: 1 });
companyJoinRequestSchema.index({ company: 1, provider: 1 }); // Unikalność - jeden provider może mieć tylko jedną aktywną prośbę

// Metoda statyczna do sprawdzania czy istnieje aktywna prośba
companyJoinRequestSchema.statics.hasActiveRequest = async function(companyId, providerId) {
  const request = await this.findOne({
    company: companyId,
    provider: providerId,
    status: 'pending'
  });
  return !!request;
};

module.exports = mongoose.model('CompanyJoinRequest', companyJoinRequestSchema);

