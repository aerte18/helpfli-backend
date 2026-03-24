?const mongoose = require('mongoose');

// Rozliczenie okresowe dla providera (Model A – faktura od providera do Helpfli)
const ProviderSettlementSchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    // Opcjonalnie w przyszłości: company (dla B2B)
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null
    },

    periodFrom: { type: Date, required: true },
    periodTo: { type: Date, required: true },

    totalRevenue: { type: Number, required: true }, // suma kwot brutto (amount)
    platformFees: { type: Number, required: true }, // suma prowizji Helpfli
    netRevenue: { type: Number, required: true }, // totalRevenue - platformFees
    currency: { type: String, default: 'PLN' },

    paymentCount: { type: Number, default: 0 },

    // Numer faktury wystawionej przez providera do Helpfli (uzupełnia provider)
    invoiceNumberFromProvider: { type: String, default: '' },

    status: {
      type: String,
      enum: ['pending', 'invoiced', 'paid'],
      default: 'pending',
      index: true
    },

    // Lista płatności użyta do rozliczenia (snapshot)
    paymentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],

    // Faktura samofakturowania wygenerowana w imieniu providera
    selfBillingInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    selfBillingStatus: {
      type: String,
      enum: ['none', 'generated', 'booked'],
      default: 'none'
    }
  },
  {
    timestamps: true
  }
);

ProviderSettlementSchema.index(
  { provider: 1, periodFrom: 1, periodTo: 1 },
  { unique: true }
);

module.exports = mongoose.model('ProviderSettlement', ProviderSettlementSchema);


