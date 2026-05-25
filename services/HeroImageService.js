/**
 * HeroImageService
 *
 * Generuje hero image dla poradników (i opcjonalnie stron PSEO) używając OpenAI
 * (DALL-E 3) lub Gemini, z fallback do deterministycznego SVG gradientu.
 *
 * Strategia:
 *  1. Jeśli OPENAI_API_KEY → DALL-E 3 (1024×1024, hq, photo style).
 *  2. Jeśli GEMINI_API_KEY → Gemini Imagen (jeśli włączone w projekcie).
 *  3. Fallback → SVG gradient z labelką (zero kosztów, zawsze działa).
 *
 * Storage:
 *  - Jeśli AWS_S3_BUCKET skonfigurowany → upload + zwrot publicznego URL.
 *  - Inaczej zwracamy data URL (dla SVG fallback to natywne — krótki tekst,
 *    dla DALL-E pobieramy obraz i zapisujemy jako data URL — tylko ostateczność).
 *
 * NB: Sharp jest już w deps – używamy go do compressji/konwersji.
 *
 * Użycie:
 *   const { generateHeroImage } = require('./HeroImageService');
 *   const url = await generateHeroImage({
 *     topic: 'Pralka błąd E20',
 *     title: 'Pralka E20 — przyczyny i jak naprawić',
 *     category: 'agd'
 *   });
 */

let logger; try { logger = require('../utils/logger'); } catch { logger = console; }

let s3Client = null;
let PutObjectCommand = null;
let s3Available = false;
try {
  const aws = require('@aws-sdk/client-s3');
  PutObjectCommand = aws.PutObjectCommand;
  s3Client = new aws.S3Client({
    region: process.env.AWS_REGION || 'eu-central-1',
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
  });
  s3Available = true;
} catch (_) { s3Available = false; }

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

let openai = null;
try {
  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (e) {
  openai = null;
}

const BUCKET = process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET;
const CDN = (process.env.AWS_S3_PUBLIC_URL || '').replace(/\/$/, '');

const CATEGORY_COLORS = {
  agd:         { from: '#fde68a', to: '#f59e0b' },   // amber
  hydraulik:   { from: '#bae6fd', to: '#0284c7' },   // sky
  elektryk:    { from: '#fef08a', to: '#eab308' },   // yellow
  ogrzewanie:  { from: '#fecaca', to: '#dc2626' },   // red
  klimatyzacja:{ from: '#cffafe', to: '#0891b2' },   // cyan
  remont:      { from: '#fed7aa', to: '#ea580c' },   // orange
  stolarz:     { from: '#ddd6fe', to: '#7c3aed' },   // violet
  sprzatanie:  { from: '#bbf7d0', to: '#16a34a' },   // green
  ogrod:       { from: '#a7f3d0', to: '#10b981' },   // emerald
  dezynsekcja: { from: '#fda4af', to: '#e11d48' },   // rose
  it:          { from: '#c7d2fe', to: '#4338ca' },   // indigo
  porady:      { from: '#cbd5e1', to: '#475569' },   // slate
  inne:        { from: '#e2e8f0', to: '#64748b' }
};

function escapeSvg(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Deterministyczny SVG gradient hero z labelką kategorii i tytułu.
 * Zwraca SVG markup (string).
 */
function buildFallbackSvg({ title = 'Helpfli', category = 'porady', tagline = 'Poradnik AI Helpfli' }) {
  const colors = CATEGORY_COLORS[category] || CATEGORY_COLORS.porady;
  const safeTitle = escapeSvg(title.length > 80 ? `${title.slice(0, 78)}…` : title);
  const safeTagline = escapeSvg(tagline);
  const safeCat = escapeSvg(category.toUpperCase());
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${colors.from}"/>
      <stop offset="100%" stop-color="${colors.to}"/>
    </linearGradient>
    <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="20" cy="20" r="2" fill="#ffffff20"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect width="1200" height="630" fill="url(#dots)"/>
  <g font-family="Inter, Segoe UI, Arial, sans-serif" fill="#ffffff">
    <text x="60" y="100" font-size="28" font-weight="600" opacity="0.85">${safeCat}</text>
    <text x="60" y="320" font-size="64" font-weight="800">${safeTitle}</text>
    <text x="60" y="560" font-size="28" font-weight="500" opacity="0.9">${safeTagline}</text>
    <text x="1080" y="100" font-size="32" font-weight="700" text-anchor="end">Helpfli</text>
  </g>
</svg>`;
}

async function uploadToS3(buffer, contentType, key) {
  if (!s3Available || !BUCKET || !PutObjectCommand) {
    throw new Error('S3 not configured');
  }
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read',
      CacheControl: 'public, max-age=2592000' // 30 dni
    })
  );
  if (CDN) return `${CDN}/${key}`;
  return `https://${BUCKET}.s3.${process.env.AWS_REGION || 'eu-central-1'}.amazonaws.com/${key}`;
}

/**
 * DALL-E 3 prompt – fotorealistyczne, ostre, bez tekstu, brand-friendly.
 */
function buildDallePrompt({ topic, title, category }) {
  return `Editorial photograph for a Polish home services blog post about "${topic}". ${title ? `Topic: ${title}.` : ''}
Category context: ${category}. Style: clean, modern, photorealistic editorial photography, soft natural light, depth of field, subtle blue/indigo accent. NO TEXT IN IMAGE. NO LOGOS. NO LETTERS. Aspect 16:9 framing, hero banner format. Focus on relevant object/tool/situation, not on faces. Professional, trustworthy, premium-but-approachable mood.`;
}

async function generateWithDallE({ topic, title, category }) {
  if (!openai) return null;
  try {
    const r = await openai.images.generate({
      model: 'dall-e-3',
      prompt: buildDallePrompt({ topic, title, category }),
      size: '1792x1024', // ~16:9
      quality: 'hd',
      n: 1,
      response_format: 'b64_json'
    });
    const b64 = r?.data?.[0]?.b64_json;
    if (!b64) return null;
    return Buffer.from(b64, 'base64');
  } catch (err) {
    logger.warn?.('[HeroImage] DALL-E error:', err.message);
    return null;
  }
}

/**
 * Główne API: generuje hero image dla artykułu i zwraca URL (S3 lub data:).
 *
 * @param {Object} args
 * @param {string} args.topic    - oryginalny topic (np. "pralka e20")
 * @param {string} args.title    - tytuł artykułu
 * @param {string} args.category - kategoria SeoArticle
 * @param {string} args.slug     - slug artykułu (do nazwy pliku w S3)
 * @returns {Promise<{ url: string, provider: 'dalle'|'svg', mimeType: string }>}
 */
async function generateHeroImage({ topic, title, category, slug }) {
  const safeSlug = (slug || (title || topic || 'helpfli').toLowerCase())
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 80);

  // 1) DALL-E
  const dalleBuf = await generateWithDallE({ topic, title, category });
  if (dalleBuf) {
    try {
      let finalBuf = dalleBuf;
      let mimeType = 'image/png';
      // Konwersja do WebP dla wagi (jeśli sharp dostępny)
      if (sharp) {
        finalBuf = await sharp(dalleBuf).resize(1200, 630, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
        mimeType = 'image/webp';
      }
      if (s3Available && BUCKET) {
        const key = `seo/hero/${safeSlug}-${Date.now()}.${mimeType === 'image/webp' ? 'webp' : 'png'}`;
        const url = await uploadToS3(finalBuf, mimeType, key);
        return { url, provider: 'dalle', mimeType };
      }
      // S3 brak — fallback do data URL (max 100KB warto zmniejszyć rozmiar)
      const dataUrl = `data:${mimeType};base64,${finalBuf.toString('base64')}`;
      return { url: dataUrl, provider: 'dalle', mimeType };
    } catch (e) {
      logger.warn?.('[HeroImage] DALL-E upload/processing error:', e.message);
      // fall through to SVG
    }
  }

  // 2) Fallback SVG (zawsze)
  const svg = buildFallbackSvg({
    title: title || topic || 'Helpfli',
    category: category || 'porady',
    tagline: 'Poradnik AI Helpfli'
  });
  const svgBuf = Buffer.from(svg, 'utf8');

  if (s3Available && BUCKET) {
    try {
      const key = `seo/hero/${safeSlug}-fallback-${Date.now()}.svg`;
      const url = await uploadToS3(svgBuf, 'image/svg+xml', key);
      return { url, provider: 'svg', mimeType: 'image/svg+xml' };
    } catch (e) {
      logger.warn?.('[HeroImage] SVG upload error:', e.message);
    }
  }

  // SVG dataURL fallback
  const dataUrl = `data:image/svg+xml;base64,${svgBuf.toString('base64')}`;
  return { url: dataUrl, provider: 'svg', mimeType: 'image/svg+xml' };
}

module.exports = {
  generateHeroImage,
  buildFallbackSvg
};
