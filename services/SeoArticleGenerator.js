/**
 * SeoArticleGenerator
 * --------------------
 * Generuje pełny poradnik SEO i zapisuje go w kolekcji `SeoArticle`.
 *
 * Strategia LLM (od najlepszej do najtańszej):
 *   1) Claude (smart)     – ANTHROPIC_API_KEY ustawione
 *   2) Gemini (cheap)     – GEMINI_API_KEY / GOOGLE_AI_API_KEY ustawione
 *   3) Hard fallback      – statyczny szablon, żeby nigdy nie zawiesić cron/admina.
 *
 * Funkcje są EXPORT-owalne i używane przez:
 *   - routes/seo.js   (admin „Wygeneruj poradnik")
 *   - cron/seoArticlesCron.js (5 nowych tematów/noc)
 */

const crypto = require('crypto');
const SeoArticle = require('../models/SeoArticle');
const { callClaudeJSON, hasClaudeKey } = require('../ai/providers/claudeProvider');
const { callGeminiJSON, hasGeminiKey } = require('../ai/providers/geminiProvider');
const {
  SEO_ARTICLE_SYSTEM_PROMPT,
  buildSeoUserPrompt
} = require('../ai/prompts/seoArticlePrompt');

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = console;
}

// ---------------- helpers ----------------

const POLISH_MAP = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n',
  ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'a', Ć: 'c', Ę: 'e', Ł: 'l', Ń: 'n',
  Ó: 'o', Ś: 's', Ź: 'z', Ż: 'z'
};

function slugify(input) {
  if (!input || typeof input !== 'string') return '';
  const stripped = input
    .split('')
    .map((ch) => POLISH_MAP[ch] || ch)
    .join('');
  return stripped
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * Sanityzacja HTML – usuwamy ryzykowne tagi (script/style/iframe/img/on*=)
 * bez dodatkowej zależności. Dla artykułów wystarcza – LLM i tak ma instrukcję
 * generować tylko bezpieczne tagi.
 */
function sanitizeArticleHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let safe = html;
  // usuń całe bloki niebezpieczne
  safe = safe.replace(/<script[\s\S]*?<\/script>/gi, '');
  safe = safe.replace(/<style[\s\S]*?<\/style>/gi, '');
  safe = safe.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  safe = safe.replace(/<img[^>]*>/gi, '');
  safe = safe.replace(/<link[^>]*>/gi, '');
  safe = safe.replace(/<meta[^>]*>/gi, '');
  // usuń atrybuty zdarzeń (on*) i javascript:
  safe = safe.replace(/\son\w+="[^"]*"/gi, '');
  safe = safe.replace(/\son\w+='[^']*'/gi, '');
  safe = safe.replace(/javascript:/gi, '');
  return safe.trim();
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function countWords(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function estimateReadingTime(text) {
  const words = countWords(text);
  return Math.max(1, Math.round(words / 200));
}

/**
 * Wyciąga spis treści z H2 w HTML i dorzuca id="..." do każdego nagłówka,
 * tak żeby frontend mógł podlinkować TOC kotwicami.
 */
function buildTocAndAnchorize(html) {
  if (!html) return { html: '', toc: [] };

  const toc = [];
  const usedIds = new Set();

  const withIds = html.replace(/<h2(\s+[^>]*)?>([\s\S]*?)<\/h2>/gi, (full, attrs, inner) => {
    const text = stripHtml(inner).trim();
    if (!text) return full;
    let baseId = slugify(text) || `sekcja-${toc.length + 1}`;
    let id = baseId;
    let i = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${i++}`;
    }
    usedIds.add(id);
    toc.push({ id, title: text });
    // Jeśli h2 już miał atrybuty, dorzucamy id; w przeciwnym razie ustawiamy.
    if (attrs && /\sid=/.test(attrs)) {
      // ma już id – zostawiamy oryginalne, ale używamy go w TOC
      const m = attrs.match(/\sid=["']([^"']+)["']/);
      if (m) {
        toc[toc.length - 1].id = m[1];
      }
      return `<h2${attrs}>${inner}</h2>`;
    }
    return `<h2${attrs || ''} id="${id}">${inner}</h2>`;
  });

  return { html: withIds, toc };
}

function ensureUnique(items) {
  const seen = new Set();
  const out = [];
  (items || []).forEach((it) => {
    const k = String(it || '').trim();
    if (!k) return;
    if (!seen.has(k.toLowerCase())) {
      seen.add(k.toLowerCase());
      out.push(k);
    }
  });
  return out;
}

function safeString(v, max = 0) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  return max > 0 ? trimmed.slice(0, max) : trimmed;
}

// ---------------- LLM calls ----------------

async function callLLMForArticle({ topic, hints }) {
  const userPrompt = buildSeoUserPrompt(topic, hints || {});
  const messages = [{ role: 'user', content: userPrompt }];

  // 1) Claude (smart)
  if (hasClaudeKey()) {
    try {
      const parsed = await callClaudeJSON(SEO_ARTICLE_SYSTEM_PROMPT, messages);
      return {
        parsed,
        provider: 'claude',
        model: process.env.AI_SMART_MODEL || process.env.CLAUDE_DEFAULT || 'claude-haiku-4-5-20251001'
      };
    } catch (err) {
      logger.warn?.('[SEO Generator] Claude failed, trying Gemini:', err.message || err);
    }
  }

  // 2) Gemini (cheap)
  if (hasGeminiKey()) {
    try {
      const parsed = await callGeminiJSON(SEO_ARTICLE_SYSTEM_PROMPT, messages);
      return {
        parsed,
        provider: 'gemini',
        model: process.env.AI_CHEAP_MODEL || 'gemini-2.0-flash'
      };
    } catch (err) {
      logger.warn?.('[SEO Generator] Gemini failed, falling back:', err.message || err);
    }
  }

  // 3) Hard fallback – nigdy nie wybuchamy, ale artykuł nie zostanie opublikowany.
  return {
    parsed: buildFallbackArticle(topic),
    provider: 'fallback',
    model: null
  };
}

function buildFallbackArticle(topic) {
  const slug = slugify(`poradnik ${topic}`) || `poradnik-${crypto.randomBytes(4).toString('hex')}`;
  const title = `Poradnik: ${topic}`;
  const intro = `Sprawdź, co warto wiedzieć o problemie „${topic}" oraz kiedy lepiej wezwać sprawdzonego wykonawcę z Helpfli.`;
  const contentHtml = `
    <h2>Co oznacza problem</h2>
    <p>${intro}</p>
    <h2>Najczęstsze przyczyny</h2>
    <ul><li>Awaria sprzętu lub zużycie elementu</li><li>Błąd użytkowania</li><li>Konserwacja zaniedbana</li></ul>
    <h2>Instrukcja krok po kroku</h2>
    <ol><li>Sprawdź najprostsze rozwiązania samodzielnie</li><li>Zabezpiecz miejsce pracy</li><li>Jeśli nie pomaga – wezwij specjalistę</li></ol>
    <h2>Kiedy wezwać specjalistę</h2>
    <p>Gdy problem dotyczy gazu, prądu lub ryzykujesz dalszymi szkodami.</p>
    <h2>Orientacyjny koszt</h2>
    <p>Koszt zależy od miasta i zakresu prac. Najtaniej zacznij od bezpłatnej wyceny w Helpfli.</p>
  `.trim();

  return {
    title,
    slug,
    category: 'porady',
    problem: topic,
    keywords: [topic.toLowerCase()],
    tldr: intro,
    intro,
    contentHtml,
    howtoSteps: [],
    howtoTotalTimeMinutes: 0,
    faq: [
      {
        question: 'Czy mogę naprawić to samodzielnie?',
        answer: 'To zależy od konkretnego problemu. Jeśli masz wątpliwości lub problem dotyczy gazu/prądu – wezwij fachowca.'
      },
      {
        question: 'Ile to kosztuje?',
        answer: 'Koszty zależą od miasta i zakresu prac. Bezpłatne wyceny dostaniesz na Helpfli.'
      }
    ],
    cta: {
      heading: 'Nie chcesz robić sam?',
      text: 'Helpfli dopasuje sprawdzonego wykonawcę z Twojej okolicy.'
    },
    metaTitle: title.slice(0, 60),
    metaDescription: `${intro} Znajdź wykonawcę na Helpfli.`.slice(0, 160),
    relatedServiceCodes: [],
    ctaCity: null
  };
}

// ---------------- core generator ----------------

/**
 * Normalizuje + waliduje JSON zwrócony przez LLM.
 * Zwraca obiekt gotowy do `new SeoArticle({...})`.
 */
function normalizeAiOutput({ raw, topic, provider, model, hints }) {
  const r = raw && typeof raw === 'object' ? raw : {};

  // Tytuł
  const title = safeString(r.title, 140) || `Poradnik: ${topic}`;

  // Slug
  let slug = slugify(r.slug || title || topic);
  if (!slug) slug = `poradnik-${crypto.randomBytes(4).toString('hex')}`;

  // Kategoria
  const allowed = [
    'agd', 'hydraulik', 'elektryk', 'ogrzewanie', 'klimatyzacja',
    'remont', 'stolarz', 'sprzatanie', 'dezynsekcja', 'ogrod', 'it', 'porady'
  ];
  let category = String(r.category || hints?.category || 'porady').toLowerCase().trim();
  if (!allowed.includes(category)) category = 'porady';

  // Treść + TOC
  const cleanHtml = sanitizeArticleHtml(r.contentHtml || '');
  const { html: contentHtml, toc } = buildTocAndAnchorize(cleanHtml);
  const plain = stripHtml(contentHtml);
  const wordCount = countWords(plain);

  // FAQ
  const faq = Array.isArray(r.faq)
    ? r.faq
        .filter((f) => f && f.question && f.answer)
        .map((f) => ({
          question: safeString(f.question, 300),
          answer: safeString(f.answer, 1500)
        }))
        .slice(0, 8)
    : [];

  // HowTo (AEO-friendly + Google rich snippet)
  const howtoSteps = Array.isArray(r.howtoSteps)
    ? r.howtoSteps
        .filter((s) => s && (s.name || s.text))
        .map((s) => ({
          name: safeString(s.name, 200) || `Krok ${(r.howtoSteps.indexOf(s) || 0) + 1}`,
          text: safeString(s.text, 800) || safeString(s.name, 200)
        }))
        .slice(0, 12)
    : [];
  const howtoTotalTimeMinutes = (() => {
    const n = parseInt(r.howtoTotalTimeMinutes, 10);
    return Number.isFinite(n) && n > 0 && n < 60 * 24 ? n : 0;
  })();

  // TL;DR (AEO/GEO) – max 320 znaków, jeśli puste, fallback do intro
  const tldr = safeString(r.tldr, 320) || safeString(r.intro, 320);

  // Meta
  const metaTitle = safeString(r.metaTitle, 70) || title.slice(0, 60);
  const metaDescription =
    safeString(r.metaDescription, 180) ||
    (safeString(r.intro, 160) || `Sprawdź poradnik o „${topic}" i znajdź wykonawcę na Helpfli.`).slice(0, 160);

  // CTA city + service codes
  const ctaCity = safeString(r.ctaCity, 80) || null;
  const relatedServiceCodes = ensureUnique(
    (Array.isArray(r.relatedServiceCodes) ? r.relatedServiceCodes : []).map((s) =>
      String(s).toLowerCase().trim()
    )
  ).slice(0, 5);

  return {
    topic,
    title,
    slug,
    category,
    problem: safeString(r.problem, 400) || topic,
    keywords: ensureUnique([
      ...(Array.isArray(r.keywords) ? r.keywords : []),
      ...(Array.isArray(hints?.keywords) ? hints.keywords : [])
    ]).slice(0, 12),
    tldr,
    intro: safeString(r.intro, 600),
    contentHtml,
    toc,
    faq,
    howtoSteps,
    howtoTotalTimeMinutes,
    metaTitle,
    metaDescription,
    heroImage: null,
    readingTime: estimateReadingTime(plain),
    wordCount,
    relatedServiceCodes,
    ctaCity,
    author: 'Zespół Helpfli',
    lastReviewedAt: new Date(),
    aiGenerated: true,
    aiProvider: provider,
    aiModel: model,
    _cta: r.cta || null // do późniejszego doklejenia do contentHtml (lub renderowania na frontendzie)
  };
}

/**
 * Wygeneruj artykuł na zadany temat i zapisz go w Mongo.
 *
 * @param {Object} params
 * @param {string} params.topic – wymagane
 * @param {Object} [params.hints] – { category, keywords, city }
 * @param {boolean} [params.publish=false] – czy od razu opublikować
 * @param {string|null} [params.generatedBy] – ObjectId admina, jeśli z panelu
 * @returns {Promise<{article: Object, created: boolean, provider: string}>}
 */
async function generateAndStoreArticle({ topic, hints = {}, publish = false, generatedBy = null }) {
  if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
    throw new Error('Topic is required and must be at least 3 characters');
  }
  const cleanTopic = topic.trim();

  // szybkie deduplikowanie po topic (bez generowania)
  const existingByTopic = await SeoArticle.findOne({
    topic: { $regex: `^${escapeRegex(cleanTopic)}$`, $options: 'i' }
  }).lean();
  if (existingByTopic) {
    return { article: existingByTopic, created: false, provider: existingByTopic.aiProvider || 'cached' };
  }

  const startedAt = Date.now();
  const { parsed, provider, model } = await callLLMForArticle({ topic: cleanTopic, hints });
  const normalized = normalizeAiOutput({ raw: parsed, topic: cleanTopic, provider, model, hints });

  // Doklej CTA na końcu HTML, jeśli LLM zwrócił osobne pole `cta`
  if (normalized._cta && normalized._cta.heading) {
    const ctaHeading = safeString(normalized._cta.heading, 120);
    const ctaText = safeString(normalized._cta.text, 400) ||
      'Helpfli dopasuje sprawdzonego wykonawcę z Twojej okolicy.';
    normalized.contentHtml += `\n<aside data-helpfli-cta="1"><h2>${ctaHeading}</h2><p>${ctaText}</p></aside>`;
  }
  delete normalized._cta;

  // Unikalność slugu
  normalized.slug = await ensureUniqueSlug(normalized.slug);

  // Twardy guard: jeśli fallback – nie publikuj automatycznie.
  const shouldPublish = publish && provider !== 'fallback';

  const article = await SeoArticle.create({
    ...normalized,
    published: shouldPublish,
    publishedAt: shouldPublish ? new Date() : undefined,
    generatedBy: generatedBy || null,
    generationDurationMs: Date.now() - startedAt
  });

  return { article: article.toObject(), created: true, provider };
}

async function ensureUniqueSlug(baseSlug) {
  let slug = baseSlug;
  let suffix = 2;
  // eslint-disable-next-line no-await-in-loop
  while (await SeoArticle.findOne({ slug }).lean()) {
    slug = `${baseSlug}-${suffix++}`;
    if (suffix > 50) {
      slug = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
      break;
    }
  }
  return slug;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  generateAndStoreArticle,
  slugify,
  buildTocAndAnchorize,
  sanitizeArticleHtml,
  normalizeAiOutput
};
