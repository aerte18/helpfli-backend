const mongoose = require("mongoose");

const RevenueSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // może być null jeśli nie wybrano jeszcze providera
  
  // Typ przychodu
  type: { 
    type: String, 
    enum: ["priority_fee", "boost_fee", "commission", "subscription"], 
    required: true 
  },
  
  // Kwota w groszach
  amount: { type: Number, required: true },
  
  // Waluta
  currency: { type: String, default: "pln" },
  
  // Status płatności
  status: { 
    type: String, 
    enum: ["pending", "paid", "failed", "refunded"], 
    default: "pending" 
  },
  
  // Opis
  description: { type: String, required: true },
  
  // Metadane
  metadata: {
    priorityFee: Number, // dopłata za priorytet
    boostFee: Number,    // dopłata za boost
    commission: Number,  // prowizja Helpfli
    package: String,     // pakiet klienta/providera
    tier: String         // tier providera
  },
  
  // Daty
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date },
  
  // Płatność
  paymentId: String,     // ID płatności z Stripe
  paymentMethod: String, // metoda płatności
  
  // Refund
  refundedAt: { type: Date },
  refundAmount: { type: Number, default: 0 },
  refundReason: String
});

// Indeksy
RevenueSchema.index({ orderId: 1 });
RevenueSchema.index({ clientId: 1 });
RevenueSchema.index({ providerId: 1 });
RevenueSchema.index({ type: 1 });
RevenueSchema.index({ status: 1 });
RevenueSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Revenue", RevenueSchema);



