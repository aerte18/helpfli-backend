/**
 * Model: SeoArticle
 *
 * Reprezentuje pojedynczy poradnik SEO wygenerowany przez AI Engine Helpfli
 * i udostępniany pod adresem `/poradnik/:slug`.
 *
 * Cel: budowa długiego ogona ruchu organicznego (kody błędów AGD,
 * „cieknący kran", „ile kosztuje hydraulik [miasto]" itd.) i przekierowanie
 * intencji do CTA „Znajdź wykonawcę".
 *
 * Pola odpowiadają strukturze, której oczekuje frontendowy renderer
 * (`SeoArticlePage.jsx`) oraz generator artykułów (`SeoArticleGenerator.js`).
 */

const mongoose = require('mongoose');

const faqEntrySchema = new mongoose.Schema(
  {
    question: { type: String, trim: true, required: true },
    answer: { type: String, trim: true, required: true }
  },
  { _id: false }
);

const tocEntrySchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    title: { type: String, trim: true, required: true }
  },
  { _id: false }
);

const seoArticleSchema = new mongoose.Schema(
  {
    // Wejście od użytkownika / cron
    topic: { type: String, trim: true, required: true }, // surowy temat, np. „pralka e20"
    title: { type: String, trim: true, required: true }, // sformatowany tytuł H1
    slug: { type: String, trim: true, required: true, unique: true, lowercase: true },
    category: {
      type: String,
      trim: true,
      lowercase: true,
      default: 'porady',
      enum: [
        'agd',
        'hydraulik',
        'elektryk',
        'ogrzewanie',
        'klimatyzacja',
        'remont',
        'stolarz',
        'sprzatanie',
        'dezynsekcja',
        'ogrod',
        'it',
        'porady',
        'inne'
      ]
    },
    problem: { type: String, trim: true }, // krótkie streszczenie problemu (1 zdanie)
    keywords: [{ type: String, trim: true }],

    // Treść
    tldr: { type: String, trim: true, default: '' }, // AEO/GEO: krótka odpowiedź (2–3 zdania) na górze artykułu — kluczowe dla cytowania w ChatGPT/Perplexity
    intro: { type: String, trim: true }, // 2–3 zdania na początek
    contentHtml: { type: String, required: true }, // pełna treść (HTML, sanitized przed zapisem)
    toc: [tocEntrySchema], // spis treści wygenerowany z H2 w contentHtml
    faq: [faqEntrySchema], // pytania FAQ (do JSON-LD)
    /**
     * Strukturyzowane kroki dla schema.org/HowTo — Google pokazuje je w SERPie
     * jako rich snippet (z numerami kroków). Wypełniamy tylko gdy artykuł
     * faktycznie ma sekcję „Instrukcja krok po kroku".
     */
    howtoSteps: [{ name: { type: String }, text: { type: String } }],
    howtoTotalTimeMinutes: { type: Number, default: 0 }, // ISO duration helper

    // SEO
    metaTitle: { type: String, trim: true },
    metaDescription: { type: String, trim: true },
    heroImage: { type: String, trim: true, default: null }, // opcjonalna ilustracja
    readingTime: { type: Number, default: 5 }, // minuty
    wordCount: { type: Number, default: 0 },

    // CTA powiązanie z usługami Helpfli
    relatedServiceCodes: [{ type: String, trim: true, lowercase: true }],
    ctaCity: { type: String, trim: true, default: null }, // jeśli temat dotyczy miasta (np. Warszawa)

    // E-E-A-T (Experience, Expertise, Authority, Trustworthiness)
    // Google + AI search (ChatGPT/Perplexity) premiują jasno zidentyfikowanego autora
    // i datę ostatniej weryfikacji. `reviewedBy` to opcjonalnie zweryfikowany fachowiec
    // z bazy Helpfli (User z rolą provider + zweryfikowany), który podpisuje treść.
    author: { type: String, trim: true, default: 'Zespół Helpfli' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByName: { type: String, trim: true, default: null },
    lastReviewedAt: { type: Date, default: null },

    // Stan publikacji
    aiGenerated: { type: Boolean, default: true },
    aiProvider: { type: String, enum: ['claude', 'gemini', 'manual', 'fallback'], default: 'claude' },
    aiModel: { type: String, trim: true, default: null },
    published: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date },

    // Statystyki
    views: { type: Number, default: 0 },

    // Audyt
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    generationDurationMs: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Indeksy: slug już ma unique, dorzucamy filtry listingowe + tekst dla wyszukiwarki
seoArticleSchema.index({ category: 1, published: 1, publishedAt: -1 });
seoArticleSchema.index({ published: 1, publishedAt: -1 });
seoArticleSchema.index({ title: 'text', topic: 'text', keywords: 'text' });

// Auto: ustaw `publishedAt` przy pierwszej publikacji
seoArticleSchema.pre('save', function preSave(next) {
  if (this.isModified('published') && this.published && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('SeoArticle', seoArticleSchema);
