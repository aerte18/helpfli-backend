?const mongoose = require('mongoose');

// Ogólny model faktur dla użytkowników (klientów) i firm
// Kwoty w groszach, VAT 23% domyślnie

const InvoiceSchema = new mongoose.Schema({
  // Właściciel dokumentu
  ownerType: {
    type: String,
    enum: ['user', 'company'],
    required: true,
    index: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
    refPath: 'ownerType' // 'User' lub 'Company'
  },

  // Numer faktury (format: INV-YYYYMMDD-XXXX)
  invoiceNumber: { type: String, unique: true },

  // Kontekst
  source: {
    type: String,
    enum: ['order', 'subscription', 'promotion', 'manual', 'provider_settlement'],
    default: 'order',
    index: true
  },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

  // Dane nabywcy (snapshot w momencie wystawienia)
  buyer: {
    name: { type: String, required: true },
    email: { type: String },
    nip: { type: String },
    address: {
      street: String,
      city: String,
      postalCode: String,
      country: { type: String, default: 'Polska' }
    }
  },

  // Dane sprzedawcy (platforma Helpfli – snapshot)
  seller: {
    name: { type: String, required: true },
    nip: { type: String },
    address: {
      street: String,
      city: String,
      postalCode: String,
      country: { type: String, default: 'Polska' }
    }
  },

  // Pozycje faktury
  items: [{
    description: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, required: true }, // w groszach
    totalPrice: { type: Number, required: true } // w groszach
  }],

  // Podsumowanie
  summary: {
    subtotal: { type: Number, required: true }, // suma pozycji (netto/brutto w zależności od konfiguracji)
    taxRate: { type: Number, default: 23 }, // VAT 23%
    taxAmount: { type: Number, required: true },
    total: { type: Number, required: true }, // subtotal + taxAmount
    currency: { type: String, default: 'PLN' }
  },

  // Status dokumentu
  status: {
    type: String,
    enum: ['draft', 'issued', 'sent', 'paid', 'cancelled'],
    default: 'issued',
    index: true
  },

  // Daty zgodnie z przepisami VAT
  issuedAt: { type: Date, default: Date.now }, // Data wystawienia
  saleDate: { type: Date, default: Date.now }, // Data sprzedaży (wymagana przez UoVAT)
  dueDate: { type: Date }, // Termin płatności (domyślnie 14 dni od wystawienia)
  paidAt: { type: Date },

  pdfUrl: { type: String },
  pdfGeneratedAt: { type: Date },

  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true
});

// Indeksy
InvoiceSchema.index({ ownerType: 1, owner: 1, createdAt: -1 });
InvoiceSchema.index({ invoiceNumber: 1 });

// Pre-save – generowanie numeru faktury i podsumowania
InvoiceSchema.pre('save', async function(next) {
  if (!this.invoiceNumber) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const todayPrefix = `INV-${year}${month}${day}-`;
    const lastInvoice = await this.constructor.findOne({
      invoiceNumber: { $regex: `^${todayPrefix}` }
    }).sort({ invoiceNumber: -1 });

    let sequence = 1;
    if (lastInvoice) {
      const lastSeq = parseInt(lastInvoice.invoiceNumber.split('-')[2]) || 0;
      sequence = lastSeq + 1;
    }

    this.invoiceNumber = `${todayPrefix}${String(sequence).padStart(4, '0')}`;
  }

  if (this.items && this.items.length > 0 && (!this.summary || !this.summary.subtotal)) {
    const subtotal = this.items.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
    const taxRate = this.summary?.taxRate != null ? this.summary.taxRate : 23;
    const taxAmount = Math.round(subtotal * (taxRate / 100));
    const total = subtotal + taxAmount;

    this.summary = this.summary || {};
    this.summary.subtotal = subtotal;
    this.summary.taxRate = taxRate;
    this.summary.taxAmount = taxAmount;
    this.summary.total = total;
  }

  if (this.status === 'paid' && !this.paidAt) {
    this.paidAt = new Date();
  }

  // Ustaw domyślny termin płatności (14 dni od wystawienia) jeśli nie podano
  if (!this.dueDate && this.issuedAt) {
    const dueDate = new Date(this.issuedAt);
    dueDate.setDate(dueDate.getDate() + 14);
    this.dueDate = dueDate;
  }

  // Ustaw datę sprzedaży na datę wystawienia jeśli nie podano
  if (!this.saleDate) {
    this.saleDate = this.issuedAt || new Date();
  }

  next();
});

InvoiceSchema.methods.markAsPaid = function() {
  this.status = 'paid';
  this.paidAt = new Date();
  return this.save();
};

InvoiceSchema.methods.toClientJSON = function() {
  return {
    _id: this._id,
    invoiceNumber: this.invoiceNumber,
    source: this.source,
    order: this.order,
    issuedAt: this.issuedAt,
    status: this.status,
    total: this.summary?.total,
    currency: this.summary?.currency || 'PLN',
    buyer: this.buyer,
    pdfUrl: this.pdfUrl
  };
};

module.exports = mongoose.model('Invoice', InvoiceSchema);


