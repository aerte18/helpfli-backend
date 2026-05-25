/**
 * MarketingContentGenerator
 * --------------------------
 * Generuje krótką treść marketingową (social/SEO) i zapisuje ją w kolekcji
 * `MarketingContent`. Działa według tej samej strategii LLM co SEO Engine:
 *
 *   1) Claude (smart)    – ANTHROPIC_API_KEY
 *   2) Gemini (cheap)    – GEMINI_API_KEY / GOOGLE_AI_API_KEY
 *   3) Hard fallback     – minimalna treść z szablonu (żeby nie wybić panelu)
 *
 * Wywołania:
 *   - routes/admin/marketingContent.js (POST /api/admin/content/generate)
 */

const MarketingContent = require('../models/MarketingContent');
const { callClaudeJSON, hasClaudeKey } = require('../ai/providers/claudeProvider');
const { callGeminiJSON, hasGeminiKey } = require('../ai/providers/geminiProvider');
const {
  MARKETING_CONTENT_SYSTEM_PROMPT,
  buildMarketingUserPrompt
} = require('../ai/prompts/marketingContentPrompt');

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = console;
}

// -------------- helpers --------------

function safeString(v, max = 0) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  return max > 0 ? trimmed.slice(0, max) : trimmed;
}

function cleanHashtag(h) {
  if (typeof h !== 'string') return '';
  return h
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, 40);
}

function uniqHashtags(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((h) => {
    const k = cleanHashtag(h);
    if (!k) return;
    const lower = k.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(k);
  });
  return out.slice(0, 20);
}

function isVideoType(contentType) {
  return contentType === 'tiktok_script' || contentType === 'reel_script';
}

// -------------- LLM --------------

async function callLLM({ category, contentType, platform, topic, extra }) {
  const userPrompt = buildMarketingUserPrompt({ category, contentType, platform, topic, extra });
  const messages = [{ role: 'user', content: userPrompt }];

  if (hasClaudeKey()) {
    try {
      const parsed = await callClaudeJSON(MARKETING_CONTENT_SYSTEM_PROMPT, messages);
      return {
        parsed,
        provider: 'claude',
        model:
          process.env.AI_SMART_MODEL ||
          process.env.CLAUDE_DEFAULT ||
          'claude-haiku-4-5-20251001'
      };
    } catch (err) {
      logger.warn?.('[Marketing Generator] Claude failed, trying Gemini:', err.message || err);
    }
  }

  if (hasGeminiKey()) {
    try {
      const parsed = await callGeminiJSON(MARKETING_CONTENT_SYSTEM_PROMPT, messages);
      return {
        parsed,
        provider: 'gemini',
        model: process.env.AI_CHEAP_MODEL || 'gemini-2.0-flash'
      };
    } catch (err) {
      logger.warn?.('[Marketing Generator] Gemini failed, falling back:', err.message || err);
    }
  }

  return {
    parsed: buildFallback({ category, contentType, platform, topic }),
    provider: 'fallback',
    model: null
  };
}

function buildFallback({ category, contentType, platform, topic }) {
  const hook = `Masz problem: ${topic}? Zanim zaczniesz kombinować — sprawdź to.`;
  const content =
    `${topic} to częsty problem w kategorii ${category}. ` +
    'Najpierw odetnij wodę/prąd, sprawdź proste przyczyny, a jeśli nie pomoże — zamów fachowca.';
  const cta = 'Nie chcesz robić sam? Znajdź wykonawcę na Helpfli.';
  return {
    title: `${topic} – ${platform}`,
    hook,
    content,
    cta,
    hashtags: ['helpfli', category, 'fachowiec', 'naprawa'],
    videoFormat: isVideoType(contentType)
      ? 'pion 9:16, 15–22 s, hook 0–3 s, ujęcia 2–4 s, napisy zawsze, CTA na końcu'
      : ''
  };
}

// -------------- normalize --------------

function normalizeAiOutput({ raw, category, contentType, platform, topic }) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const title =
    safeString(r.title, 120) ||
    `${topic.slice(0, 60)} – ${platform}`;

  const hook = safeString(r.hook, 400);
  const content = safeString(r.content, 4000);
  const cta =
    safeString(r.cta, 400) ||
    'Nie chcesz robić sam? Znajdź wykonawcę na Helpfli.';

  const hashtags = uniqHashtags(r.hashtags);
  let videoFormat = safeString(r.videoFormat, 400);
  if (!videoFormat && isVideoType(contentType)) {
    videoFormat = 'pion 9:16, 15–22 s, hook 0–3 s, ujęcia 2–4 s, napisy zawsze, CTA na końcu';
  }

  return {
    title,
    category,
    contentType,
    platform,
    topic,
    hook,
    content,
    cta,
    hashtags,
    videoFormat
  };
}

// -------------- core --------------

/**
 * Wygeneruj treść marketingową na zadany temat i zapisz w Mongo.
 *
 * @param {Object} params
 * @param {string} params.category     hydraulik | AGD | elektryk | remont | zmywarka | pralka
 * @param {string} params.contentType  facebook_post | instagram_caption | ...
 * @param {string} params.platform     facebook | instagram | tiktok | youtube | linkedin | website
 * @param {string} params.topic        krótki temat ("Cieknący kran w kuchni")
 * @param {Object} [params.extra]      { audience, city, tone }
 * @param {string|null} [params.createdBy]
 * @returns {Promise<{item: Object, provider: string, model: string|null}>}
 */
async function generateAndStoreContent({
  category,
  contentType,
  platform,
  topic,
  extra = {},
  createdBy = null
}) {
  if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
    throw new Error('Topic is required (min 3 chars)');
  }
  if (!MarketingContent.CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}`);
  }
  if (!MarketingContent.CONTENT_TYPES.includes(contentType)) {
    throw new Error(`Invalid contentType: ${contentType}`);
  }
  if (!MarketingContent.PLATFORMS.includes(platform)) {
    throw new Error(`Invalid platform: ${platform}`);
  }

  const cleanTopic = topic.trim();
  const startedAt = Date.now();

  const { parsed, provider, model } = await callLLM({
    category,
    contentType,
    platform,
    topic: cleanTopic,
    extra
  });

  const normalized = normalizeAiOutput({
    raw: parsed,
    category,
    contentType,
    platform,
    topic: cleanTopic
  });

  const doc = await MarketingContent.create({
    ...normalized,
    prompt: buildMarketingUserPrompt({
      category,
      contentType,
      platform,
      topic: cleanTopic,
      extra
    }),
    aiProvider: provider,
    aiModel: model,
    generationDurationMs: Date.now() - startedAt,
    createdBy: createdBy || null,
    status: 'draft'
  });

  return { item: doc.toObject(), provider, model };
}

module.exports = {
  generateAndStoreContent,
  normalizeAiOutput
};
