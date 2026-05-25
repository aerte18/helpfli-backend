/**
 * SeoTranslator – tłumaczenie poradników PL → UK (j. ukraiński).
 *
 * Cel: dotarcie do ~1.5M ukraińskojęzycznych użytkowników w PL (zerowa konkurencja
 * w wertykalu „hydraulik Warszawa po ukraińsku").
 *
 * Architektura:
 *  - LLM (Claude → Gemini fallback) z bardzo restrykcyjnym promptem,
 *  - zachowuje strukturę HTML (te same tagi, ten sam układ),
 *  - NIE tłumaczy: linków, nazw własnych produktów (Bosch, Samsung), kodów błędów (E20).
 *  - zachowuje wszystkie atrybuty / IDki TOC (tłumaczone tylko `title` w TOC).
 *  - dodaje nowy `tldr` i `metaTitle/Description` w UK.
 *
 * Limity:
 *  - LLM token cost: artykuł ~3k tokens; budżet 1000 artykułów ~ ~30 USD na Claude Sonnet.
 *  - Cache: nie cache'ujemy w pamięci – wynik trafia do `SeoArticle.translations.uk`.
 */

const { callClaudeJSON, hasClaudeKey } = require('../ai/providers/claudeProvider');
const { callGeminiJSON, hasGeminiKey } = require('../ai/providers/geminiProvider');

let logger; try { logger = require('../utils/logger'); } catch { logger = console; }

const TRANSLATE_SYSTEM_PROMPT = `Jesteś profesjonalnym tłumaczem polsko-ukraińskim z bagażem >10 lat doświadczenia w tłumaczeniach technicznych (urządzenia AGD, hydraulika, elektryka, remonty).

ZADANIE: przetłumacz przekazany artykuł SEO Helpfli z języka polskiego na ukraiński, zachowując pełną strukturę HTML i SEO.

ZASADY:
- Tłumacz na NATURALNY ukraiński, taki jakim posługują się Ukraińcy mieszkający w Polsce w 2026 r. (mowa standardowa, nie hutsulski/zachodni dialekt).
- Zachowaj DOKŁADNIE te same tagi HTML w \`contentHtml\` (\`<h2>\`, \`<h3>\`, \`<p>\`, \`<ul>\`, \`<ol>\`, \`<li>\`, \`<strong>\`, \`<em>\`, \`<a>\`, \`<table>\`, \`<thead>\`, \`<tbody>\`, \`<tr>\`, \`<th>\`, \`<td>\`).
- Zachowaj kolejność i liczbę sekcji H2 (NIE zmieniaj nagłówków na inne tematy).
- NIE tłumacz: nazw własnych marek (Bosch, Samsung, LG, Whirlpool, Electrolux, Beko, Indesit), kodów błędów (E10, E20, F23), nazw miast w slugach (Warszawa, Kraków).
- Nazwy miast w treści tłumacz na ukraiński (Warszawa → Варшава, Kraków → Краків, Wrocław → Вроцлав, Gdańsk → Гданськ).
- Waluta zostaje PLN (złоті). NIE konwertuj na UAH.
- Linki w \`<a href="...">\` zostawiaj bez zmian.
- W FAQ przetłumacz zarówno pytanie jak i odpowiedź, ale zachowaj ten sam liczba par.
- W TOC: przetłumacz \`title\`, ale ZACHOWAJ \`id\` identyczny jak w polskim oryginale.
- Pole \`tldr\` (Quick Answer) musi być 3–5 zdań w naturalnym ukraińskim.
- Pole \`metaTitle\` 50–60 znaków, \`metaDescription\` 140–160 znaków – w ukraińskim, zoptymalizowane pod SEO.

ODPOWIEDŹ – WYŁĄCZNIE JSON o strukturze:
{
  "title": "Tytuł H1 po ukraińsku",
  "intro": "Wstęp po ukraińsku (2-3 zdania, bez HTML)",
  "tldr": "TL;DR po ukraińsku (3-5 zdań, bez HTML)",
  "contentHtml": "Pełna treść HTML po ukraińsku (te same tagi co PL)",
  "toc": [{"id": "co-oznacza-problem", "title": "Що означає проблема"}, ...],
  "faq": [{"question": "Питання?", "answer": "Відповідь."}, ...],
  "metaTitle": "Meta title po ukraińsku (50-60 znaków)",
  "metaDescription": "Meta description po ukraińsku (140-160 znaków)"
}

NIE DODAWAJ żadnego tekstu przed ani po JSON. Zacznij od { i zakończ na }.`;

function buildUserPrompt(article) {
  return `Artykuł PL do przetłumaczenia na ukraiński (zachowaj strukturę HTML i ID w TOC):

TYTUŁ (PL): ${article.title}

INTRO (PL): ${article.intro || ''}

TLDR (PL): ${article.tldr || ''}

META_TITLE (PL): ${article.metaTitle || ''}
META_DESCRIPTION (PL): ${article.metaDescription || ''}

CONTENT_HTML (PL):
${article.contentHtml}

TOC (PL): ${JSON.stringify(article.toc || [], null, 0)}

FAQ (PL): ${JSON.stringify(article.faq || [], null, 0)}

Zwróć WYŁĄCZNIE JSON zgodny z instrukcją systemową.`;
}

/**
 * Tłumaczy artykuł PL → UK i zwraca payload (NIE zapisuje do DB).
 *
 * @param {Object} article – dokument SeoArticle (lean lub Mongoose).
 * @returns {Promise<{translation: Object, provider: 'claude'|'gemini', model: string}>}
 */
async function translateArticleToUk(article) {
  if (!article || !article.contentHtml) {
    throw new Error('Article with contentHtml is required');
  }

  const messages = [{ role: 'user', content: buildUserPrompt(article) }];

  // Claude primary
  if (hasClaudeKey()) {
    try {
      const parsed = await callClaudeJSON(TRANSLATE_SYSTEM_PROMPT, messages);
      if (parsed && parsed.contentHtml) {
        return { translation: normalizeTranslation(parsed, article), provider: 'claude', model: 'claude' };
      }
    } catch (e) {
      logger.warn?.('[SeoTranslator] Claude failed, fallback to Gemini:', e.message);
    }
  }
  // Gemini fallback
  if (hasGeminiKey()) {
    try {
      const parsed = await callGeminiJSON(TRANSLATE_SYSTEM_PROMPT, messages);
      if (parsed && parsed.contentHtml) {
        return { translation: normalizeTranslation(parsed, article), provider: 'gemini', model: 'gemini' };
      }
    } catch (e) {
      logger.warn?.('[SeoTranslator] Gemini failed:', e.message);
    }
  }
  throw new Error('Żaden provider AI nie potrafił przetłumaczyć artykułu');
}

function normalizeTranslation(raw, src) {
  // Wymuś ID-y TOC zgodne z oryginałem (jeśli LLM się pomylił)
  let toc = Array.isArray(raw.toc) ? raw.toc : [];
  if (Array.isArray(src.toc) && src.toc.length > 0) {
    toc = src.toc.map((srcEntry, idx) => ({
      id: srcEntry.id,
      title: toc[idx]?.title || srcEntry.title || ''
    }));
  }
  const faq = Array.isArray(raw.faq)
    ? raw.faq
        .filter((f) => f && f.question && f.answer)
        .map((f) => ({ question: String(f.question).trim(), answer: String(f.answer).trim() }))
        .slice(0, 8)
    : [];
  return {
    title: String(raw.title || src.title || '').trim().slice(0, 240),
    intro: String(raw.intro || '').trim().slice(0, 600),
    tldr: String(raw.tldr || '').trim().slice(0, 800),
    contentHtml: String(raw.contentHtml || ''),
    toc,
    faq,
    metaTitle: String(raw.metaTitle || raw.title || '').trim().slice(0, 70),
    metaDescription: String(raw.metaDescription || '').trim().slice(0, 200),
    translatedAt: new Date(),
    translatedBy: null
  };
}

/**
 * Tłumaczy + zapisuje do `SeoArticle.translations.uk`.
 *
 * @param {Object} article – Mongoose document
 * @returns {Promise<{ok: boolean, provider: string}>}
 */
async function translateAndStore(article) {
  const { translation, provider } = await translateArticleToUk(article);
  translation.translatedBy = provider;
  await article.constructor.updateOne(
    { _id: article._id },
    { $set: { 'translations.uk': translation } }
  );
  return { ok: true, provider };
}

module.exports = {
  translateArticleToUk,
  translateAndStore
};
