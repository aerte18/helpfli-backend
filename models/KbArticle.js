const mongoose = require('mongoose');

const KbArticleSchema = new mongoose.Schema({
  slug: { type: String, unique: true, index: true },
  title: String,
  content: String,
  tags: [String],
  lang: { type: String, default: 'pl' },
  category: { type: String, default: 'inne' },
  isActive: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Indexes
KbArticleSchema.index({ slug: 1, lang: 1 }, { unique: false });
KbArticleSchema.index({ category: 1, isActive: 1, createdAt: -1 });

module.exports = mongoose.model('KbArticle', KbArticleSchema);
