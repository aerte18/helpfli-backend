const mongoose = require('mongoose');

const CompanyInvoiceSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  
  // Numer faktury (format: INV-YYYYMMDD-XXXX)
  invoiceNumber: { type: String, required: true, unique: true },
  
  // Typ faktury
  type: {
    type: String,
    enum: ['monthly_summary', 'custom_period', 'single_order', 'subscription', 'manual'],
    default: 'monthly_summary'
  },
  
  // Okres rozliczeniowy
  period: {
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true }
  },
  
  // Dane firmy (snapshot w momencie wystawienia)
  companyData: {
    name: { type: String, required: true },
    nip: { type: String, required: true },
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
    unitPrice: { type: Number, required: true }, // W groszach
    totalPrice: { type: Number, required: true }, // W groszach
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  }],
  
  // Podsumowanie
  summary: {
    subtotal: { type: Number, required: true }, // W groszach (suma pozycji)
    taxRate: { type: Number, default: 23 }, // VAT 23%
    taxAmount: { type: Number, required: true }, // W groszach
    total: { type: Number, required: true }, // W groszach (subtotal + tax)
    currency: { type: String, default: 'PLN' }
  },
  
  // Status faktury
  status: {
    type: String,
    enum: ['draft', 'issued', 'sent', 'paid', 'overdue', 'cancelled'],
    default: 'draft'
  },
  
  // Daty
  issuedAt: { type: Date },
  dueDate: { type: Date, required: true },
  paidAt: { type: Date },
  
  // Płatność
  payment: {
    method: { type: String }, // 'wallet', 'stripe', 'transfer', etc.
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    transactionId: { type: String }, // ID transakcji w systemie płatności
    paidAmount: { type: Number }, // W groszach
    paidAt: { type: Date }
  },
  
  // PDF faktury
  pdfUrl: { type: String },
  pdfGeneratedAt: { type: Date },
  
  // Notatki
  notes: { type: String },
  
  // Metadane
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indeksy
CompanyInvoiceSchema.index({ company: 1, createdAt: -1 });
CompanyInvoiceSchema.index({ invoiceNumber: 1 });
CompanyInvoiceSchema.index({ status: 1 });
CompanyInvoiceSchema.index({ 'period.startDate': 1, 'period.endDate': 1 });

// Pre-save middleware - generuj numer faktury
CompanyInvoiceSchema.pre('save', async function(next) {
  if (!this.invoiceNumber) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    // Znajdź ostatnią fakturę z dzisiejszą datą
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
  
  // Oblicz podsumowanie jeśli nie zostało ustawione
  if (this.items && this.items.length > 0 && !this.summary.subtotal) {
    const subtotal = this.items.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
    const taxAmount = Math.round(subtotal * (this.summary.taxRate / 100));
    const total = subtotal + taxAmount;
    
    this.summary.subtotal = subtotal;
    this.summary.taxAmount = taxAmount;
    this.summary.total = total;
  }
  
  // Ustaw datę wystawienia jeśli faktura została wydana
  if (this.status === 'issued' && !this.issuedAt) {
    this.issuedAt = new Date();
  }
  
  // Ustaw datę płatności jeśli faktura została opłacona
  if (this.status === 'paid' && !this.paidAt) {
    this.paidAt = new Date();
  }
  
  this.updatedAt = new Date();
  next();
});

// Metody instancji
CompanyInvoiceSchema.methods.markAsPaid = function(paymentMethod, paymentId, transactionId, paidAmount) {
  this.status = 'paid';
  this.paidAt = new Date();
  this.payment = {
    method: paymentMethod,
    paymentId: paymentId || null,
    transactionId: transactionId || null,
    paidAmount: paidAmount || this.summary.total,
    paidAt: new Date()
  };
  return this.save();
};

CompanyInvoiceSchema.methods.generatePDF = async function() {
  // Generowanie PDF faktury - podstawowa implementacja
  // W przyszłości można użyć biblioteki jak pdfkit lub puppeteer
  // Na razie zwracamy informację że PDF można wygenerować
  // Implementacja pełnego PDF wymaga dodatkowej biblioteki (np. pdfkit)
  try {
    // TODO: Implementacja pełnego generowania PDF wymaga:
    // 1. Instalacji biblioteki: npm install pdfkit
    // 2. Utworzenia szablonu faktury
    // 3. Generowania pliku PDF z danymi faktury
    
    // Na razie zwracamy obiekt z informacją o możliwości generowania
    return {
      canGenerate: true,
      invoiceNumber: this.invoiceNumber,
      totalAmount: this.summary.total,
      message: 'Generowanie PDF wymaga dodatkowej konfiguracji biblioteki pdfkit'
    };
  } catch (error) {
    console.error('Error generating PDF:', error);
    return null;
  }
};

module.exports = mongoose.model('CompanyInvoice', CompanyInvoiceSchema);

