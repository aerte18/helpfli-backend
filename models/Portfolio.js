// Portfolio wykonawcy - galeria prac i projektów
const mongoose = require('mongoose');

const portfolioItemSchema = new mongoose.Schema({
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: { type: String },
  category: { type: String }, // np. 'remont', 'instalacja', 'naprawa'
  service: { type: String }, // Kod usługi
  photos: [{ 
    url: { type: String, required: true },
    thumbnail: { type: String }, // URL do miniaturki
    caption: { type: String },
    order: { type: Number, default: 0 }
  }],
  beforeAfter: {
    before: [{ type: String }], // URL do zdjęć "przed"
    after: [{ type: String }] // URL do zdjęć "po"
  },
  location: {
    city: { type: String },
    address: { type: String }
  },
  completedAt: { type: Date },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' }, // Opcjonalne powiązanie ze zleceniem
  tags: [{ type: String }], // Tagi dla łatwego wyszukiwania
  featured: { type: Boolean, default: false }, // Czy wyróżnione w portfolio
  views: { type: Number, default: 0 }, // Liczba wyświetleń
  likes: { type: Number, default: 0 }, // Liczba polubień
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Użytkownicy, którzy polubili
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published' }
}, {
  timestamps: true
});

// Indexy
portfolioItemSchema.index({ provider: 1, status: 1, createdAt: -1 });
portfolioItemSchema.index({ category: 1, service: 1 });
portfolioItemSchema.index({ featured: 1, createdAt: -1 });

module.exports = mongoose.models.PortfolioItem || mongoose.model('PortfolioItem', portfolioItemSchema);













