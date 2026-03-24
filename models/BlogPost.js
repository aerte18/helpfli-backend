const mongoose = require('mongoose');

const blogPostSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  excerpt: { type: String, required: true }, // Krótki opis dla listy
  content: { type: String, required: true }, // Pełna treść (markdown lub HTML)
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Opcjonalnie - autor posta
  category: { type: String, enum: ['porady', 'case-study', 'nowości', 'seo'], default: 'porady' },
  tags: [{ type: String }], // Tagi dla SEO i kategoryzacji
  featuredImage: { type: String }, // URL do zdjęcia głównego
  metaTitle: { type: String }, // SEO meta title (jeśli różny od title)
  metaDescription: { type: String }, // SEO meta description
  keywords: [{ type: String }], // SEO keywords
  published: { type: Boolean, default: false },
  publishedAt: { type: Date },
  views: { type: Number, default: 0 },
  readingTime: { type: Number }, // Czas czytania w minutach (obliczany automatycznie)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indeksy dla szybkiego wyszukiwania
blogPostSchema.index({ slug: 1 });
blogPostSchema.index({ published: 1, publishedAt: -1 });
blogPostSchema.index({ category: 1 });
blogPostSchema.index({ tags: 1 });

// Middleware do aktualizacji updatedAt
blogPostSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  if (this.isNew && this.published) {
    this.publishedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('BlogPost', blogPostSchema);










