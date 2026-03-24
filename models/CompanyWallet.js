const mongoose = require('mongoose');

const CompanyWalletSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  
  // Saldo portfela (w groszach)
  balance: { type: Number, default: 0 }, // Saldo dostępne
  
  // Historia transakcji
  transactions: [{
    type: { 
      type: String, 
      enum: ['deposit', 'withdrawal', 'payment', 'refund', 'fee', 'subscription', 'order_payment', 'order_revenue'],
      required: true 
    },
    amount: { type: Number, required: true }, // W groszach, dodatnie dla wpłat, ujemne dla wypłat
    description: { type: String },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyInvoice' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Użytkownik który wykonał transakcję
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
  }],
  
  // Ustawienia portfela
  settings: {
    autoRecharge: { type: Boolean, default: false }, // Automatyczne doładowanie
    autoRechargeThreshold: { type: Number, default: 0 }, // Próg poniżej którego doładować (w groszach)
    autoRechargeAmount: { type: Number, default: 0 }, // Kwota doładowania (w groszach)
    autoRechargePaymentMethod: { type: String }, // ID metody płatności w Stripe
    allowNegativeBalance: { type: Boolean, default: false }, // Czy pozwalać na ujemne saldo
    maxNegativeBalance: { type: Number, default: 0 } // Maksymalne ujemne saldo (w groszach)
  },
  
  // Statystyki
  stats: {
    totalDeposited: { type: Number, default: 0 }, // Łącznie wpłacone (w groszach)
    totalWithdrawn: { type: Number, default: 0 }, // Łącznie wypłacone (w groszach)
    totalSpent: { type: Number, default: 0 }, // Łącznie wydane (w groszach)
    totalEarned: { type: Number, default: 0 }, // Łącznie zarobione (w groszach)
    lastTransactionAt: { type: Date }
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indeksy
CompanyWalletSchema.index({ company: 1 });
CompanyWalletSchema.index({ 'transactions.createdAt': -1 });

// Metody instancji
CompanyWalletSchema.methods.addTransaction = function(type, amount, options = {}) {
  const transaction = {
    type,
    amount,
    description: options.description || '',
    orderId: options.orderId || null,
    paymentId: options.paymentId || null,
    invoiceId: options.invoiceId || null,
    userId: options.userId || null,
    metadata: options.metadata || {},
    createdAt: new Date()
  };
  
  this.transactions.push(transaction);
  this.balance += amount; // amount może być ujemne dla wypłat
  
  // Aktualizuj statystyki
  if (amount > 0) {
    if (type === 'deposit' || type === 'order_revenue') {
      this.stats.totalDeposited += amount;
      this.stats.totalEarned += amount;
    }
  } else {
    if (type === 'withdrawal') {
      this.stats.totalWithdrawn += Math.abs(amount);
    } else if (type === 'payment' || type === 'fee' || type === 'subscription' || type === 'order_payment') {
      this.stats.totalSpent += Math.abs(amount);
    }
  }
  
  this.stats.lastTransactionAt = new Date();
  this.updatedAt = new Date();
  
  return this.save();
};

CompanyWalletSchema.methods.canAfford = function(amount) {
  if (this.settings.allowNegativeBalance) {
    return this.balance - amount >= -this.settings.maxNegativeBalance;
  }
  return this.balance >= amount;
};

CompanyWalletSchema.methods.getBalance = function() {
  return {
    available: this.balance,
    currency: 'PLN',
    formatted: (this.balance / 100).toFixed(2) + ' zł'
  };
};

CompanyWalletSchema.methods.getTransactions = function(limit = 50, offset = 0) {
  return this.transactions
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(offset, offset + limit);
};

module.exports = mongoose.model('CompanyWallet', CompanyWalletSchema);







