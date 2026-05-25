/**
 * Model: MarketingContent
 *
 * Treści marketingowe AI dla Helpfli (social media + SEO snippets).
 *
 * Etap MVP: generujemy treści w panelu admina (/admin/content), zapisujemy
 * w bazie, kopiujemy ręcznie i wklejamy na TikToka/IG/FB. Bez automatycznej
 * publikacji — świeże konta social szybko dostają blokadę za API posty.
 *
 * Etap 2 (future-ready): są już pola `externalPostId`, `scheduledAt`,
 * `publishedAt`, `publishError` — wystarczy dorobić integrację (Meta Graph,
 * TikTok Business API, LinkedIn) i scheduler.
 */

const mongoose = require('mongoose');

const CONTENT_TYPES = [
  'facebook_post',
  'instagram_caption',
  'tiktok_script',
  'reel_script',
  'faq',
  'cta',
  'seo_snippet'
];

const PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'linkedin',
  'website'
];

const STATUSES = ['draft', 'ready', 'published'];

const CATEGORIES = [
  'hydraulik',
  'AGD',
  'elektryk',
  'remont',
  'zmywarka',
  'pralka'
];

const marketingContentSchema = new mongoose.Schema(
  {
    // --- meta ---
    title: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, enum: CATEGORIES, required: true },
    contentType: { type: String, enum: CONTENT_TYPES, required: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    status: { type: String, enum: STATUSES, default: 'draft', index: true },

    // --- wejście do AI ---
    topic: { type: String, trim: true, required: true },
    prompt: { type: String, trim: true, default: '' },

    // --- wynik AI ---
    hook: { type: String, trim: true, default: '' },
    content: { type: String, trim: true, default: '' },
    cta: { type: String, trim: true, default: '' },
    hashtags: [{ type: String, trim: true }],
    videoFormat: { type: String, trim: true, default: '' }, // np. "vertical 9:16, 15-30s, hook 0-3s"

    // --- audyt ---
    aiProvider: { type: String, enum: ['claude', 'gemini', 'manual', 'fallback'], default: 'claude' },
    aiModel: { type: String, trim: true, default: null },
    generationDurationMs: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    // --- future-ready: automatyczna publikacja (NIEAKTYWNE w MVP) ---
    externalPostId: { type: String, trim: true, default: null },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    publishError: { type: String, trim: true, default: null }
  },
  { timestamps: true }
);

marketingContentSchema.index({ category: 1, status: 1, createdAt: -1 });
marketingContentSchema.index({ platform: 1, status: 1, createdAt: -1 });
marketingContentSchema.index({ contentType: 1, createdAt: -1 });

marketingContentSchema.statics.CONTENT_TYPES = CONTENT_TYPES;
marketingContentSchema.statics.PLATFORMS = PLATFORMS;
marketingContentSchema.statics.STATUSES = STATUSES;
marketingContentSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('MarketingContent', marketingContentSchema);
module.exports.CONTENT_TYPES = CONTENT_TYPES;
module.exports.PLATFORMS = PLATFORMS;
module.exports.STATUSES = STATUSES;
module.exports.CATEGORIES = CATEGORIES;
