const mongoose = require('mongoose');

const faqEntrySchema = new mongoose.Schema(
  { question: String, answer: String },
  { _id: false }
);

/**
 * SeoLocalPage – Programmatic SEO (PSEO).
 *
 * Każdy dokument = jedna landing page typu "hydraulik warszawa".
 * URL: /wykonawcy/:serviceSlug/:citySlug
 *
 * Idea:
 *  - generujemy LAZY (on first hit) lub pre-build via admin (cron co tydzień)
 *  - intro + FAQ generuje LLM (unikalna treść per kombinacja)
 *  - live stats (avg cena, liczba wykonawców) dociągamy z MarketplaceStatsService
 *  - dane są dynamiczne – odświeżamy podczas renderu (cache 10 min), żeby content
 *    był zawsze świeży, ale zapisana wersja intro+FAQ pozostaje stabilna dla SEO
 *
 * Konkurencja (Fixly/Oferteo) ma kopiowane intro między miastami – my mamy unikalne.
 */
const seoLocalPageSchema = new mongoose.Schema(
  {
    serviceSlug: { type: String, required: true, lowercase: true, trim: true, index: true },
    serviceName: { type: String, required: true, trim: true },
    citySlug: { type: String, required: true, lowercase: true, trim: true, index: true },
    cityName: { type: String, required: true, trim: true },

    // Pełny URL slug (np. "hydraulik-warszawa") – do szybkiego lookupu i sitemap
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    // Generowane treści LLM (unikalne per kombinacja)
    title: { type: String, trim: true },
    metaTitle: { type: String, trim: true },
    metaDescription: { type: String, trim: true },
    intro: { type: String, trim: true }, // 2–4 zdania
    contentHtml: { type: String, default: '' }, // dodatkowa sekcja "Co warto wiedzieć"
    faq: [faqEntrySchema],

    aiProvider: { type: String, enum: ['claude', 'gemini', 'manual', 'fallback'], default: 'claude' },
    aiModel: { type: String, trim: true, default: null },

    // Migawka statystyk z momentu ostatniej generacji
    // (frontend i tak pobiera live, ale to fallback na wypadek wolnego DB)
    statsSnapshot: {
      providerCount: { type: Number, default: 0 },
      verifiedCount: { type: Number, default: 0 },
      avgRating: { type: Number, default: null },
      medianPrice: { type: Number, default: null },
      sampleSize: { type: Number, default: 0 },
      recentOrders30d: { type: Number, default: null }
    },

    published: { type: Boolean, default: true, index: true },
    lastBuiltAt: { type: Date, default: Date.now },
    views: { type: Number, default: 0 }
  },
  { timestamps: true }
);

seoLocalPageSchema.index({ serviceSlug: 1, citySlug: 1 }, { unique: true });
seoLocalPageSchema.index({ published: 1, lastBuiltAt: -1 });

module.exports =
  mongoose.models.SeoLocalPage || mongoose.model('SeoLocalPage', seoLocalPageSchema);
