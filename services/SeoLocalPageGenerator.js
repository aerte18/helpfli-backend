/**
 * SeoLocalPageGenerator
 * ---------------------
 * Generator PSEO landing pages „usługa × miasto" (Programmatic SEO).
 *
 * Per (service, city) generujemy raz unikalny intro + FAQ + content przez LLM
 * (Claude → Gemini → fallback). Statystyki są zaszyte w prompt jako fakty,
 * dzięki czemu LLM tworzy treść bazowaną na realnych danych Helpfli — nie
 * generyczną „ogólnopolską" formułkę. To istotna przewaga nad konkurencją
 * (Fixly/Oferteo używa wspólnego templatu dla wszystkich miast).
 */

const SeoLocalPage = require('../models/SeoLocalPage');
const Service = require('../models/Service');
const { TOP_PL_CITIES_BY_SLUG } = require('../utils/polishCities');
const MarketplaceStats = require('./MarketplaceStatsService');
const { callClaudeJSON, hasClaudeKey } = require('../ai/providers/claudeProvider');
const { callGeminiJSON, hasGeminiKey } = require('../ai/providers/geminiProvider');
const { sanitizeArticleHtml } = require('./SeoArticleGenerator');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

const LOCAL_PROMPT = `Jesteś redaktorem Helpfli – marketplace usług dla domu w Polsce.

Twoje zadanie: napisać UNIKALNĄ stronę landing page dla kombinacji USŁUGA × MIASTO.
Otrzymasz prawdziwe dane Helpfli (liczbę wykonawców w mieście, średnie ceny zleceń,
ilość aktywności w ostatnich 30 dniach). Wpleć je naturalnie w tekst – to NASZ UNIKAT.

ZASADY:
- Po polsku, prosto, konkretnie, bez lania wody.
- NIE wymyślaj wykonawców z imienia/nazwiska. NIE wymyślaj firm. NIE podawaj numerów telefonu.
- Cena: opieraj się na podanych medianach. Jeśli nie mamy próby (sampleSize=0) – używaj wide markets PL 2026.
- Intro 2–4 zdania, naturalna nasycenie frazą "${'${serviceName}'} ${'${cityName}'}".
- FAQ: 5–7 pytań/odpowiedzi, każde realne i odpowiadające intencji szukającego
  (np. „ile kosztuje", „jak szybko przyjedzie", „czy mają gwarancję", „czy zweryfikowani").
- contentHtml: dodatkowa krótka sekcja H2 "Co warto wiedzieć" + lista korzyści Helpfli (3–5 punktów,
  konkretne, bez marketingowego bełkotu). NIE używaj <h1>, <script>, <style>, <iframe>, <img>.
- metaTitle 50–60 znaków, "${'${serviceName}'} ${'${cityName}'} – ..." (slogan, korzyść).
- metaDescription 140–160 znaków.

ODPOWIEDŹ – WYŁĄCZNIE JSON:
{
  "title": "...",
  "metaTitle": "...",
  "metaDescription": "...",
  "intro": "2–4 zdania, czysty tekst bez HTML",
  "contentHtml": "<h2>Co warto wiedzieć</h2><ul><li>...</li></ul>",
  "faq": [ { "question": "...", "answer": "..." } ]
}`;

function buildUserPrompt({ serviceName, cityName, stats }) {
  const lines = [
    `Usługa: ${serviceName}`,
    `Miasto: ${cityName}`,
    `Liczba aktywnych wykonawców w mieście: ${stats.providers?.count || 0}`,
    `Zweryfikowanych: ${stats.providers?.verifiedCount || 0}`,
    `Średnia ocena (z opinii): ${stats.providers?.avgRating ?? 'brak danych'}`,
    `Mediana ceny zleceń (ostatnie ${stats.prices?.days || 180} dni): ${
      stats.prices?.median ? `${stats.prices.median} zł` : 'brak danych'
    }`,
    `Próbka cen (ile zleceń): ${stats.prices?.sampleSize || 0}`,
    stats.prices?.p25 && stats.prices?.p75
      ? `Widełki cen (25–75%): ${stats.prices.p25}–${stats.prices.p75} zł`
      : '',
    `Zleceń ostatnie 30 dni: ${stats.recentOrders30d ?? 'brak danych'}`
  ].filter(Boolean);

  return `Wygeneruj landing page Helpfli na podstawie poniższych REALNYCH danych z platformy:\n\n${lines.join(
    '\n'
  )}\n\nPamiętaj: wplec liczby naturalnie, nie kopiuj formatki.`;
}

async function callLLM({ serviceName, cityName, stats }) {
  const messages = [{ role: 'user', content: buildUserPrompt({ serviceName, cityName, stats }) }];

  if (hasClaudeKey()) {
    try {
      const out = await callClaudeJSON(LOCAL_PROMPT, messages);
      return { raw: out, provider: 'claude', model: process.env.AI_SMART_MODEL || null };
    } catch (err) {
      logger.warn?.('[SeoLocal] Claude failed, falling back to Gemini:', err.message);
    }
  }
  if (hasGeminiKey()) {
    try {
      const out = await callGeminiJSON(LOCAL_PROMPT, messages);
      return { raw: out, provider: 'gemini', model: process.env.AI_CHEAP_MODEL || null };
    } catch (err) {
      logger.warn?.('[SeoLocal] Gemini failed, falling back to template:', err.message);
    }
  }
  return null;
}

function buildFallback({ serviceName, cityName, stats }) {
  const count = stats.providers?.count || 0;
  const median = stats.prices?.median || null;

  const intro = count
    ? `Szukasz fachowca, który wykona usługę „${serviceName}" w mieście ${cityName}? Na Helpfli zlecisz pracę zaufanym wykonawcom z Twojej okolicy.${
        count ? ` W tej chwili w ${cityName} mamy ${count} aktywnych wykonawców.` : ''
      }${median ? ` Mediana ceny ostatnich zleceń to ${median} zł.` : ''}`
    : `Helpfli dopasuje Ci sprawdzonego wykonawcę usługi „${serviceName}" w ${cityName}. Opisz problem, my zajmiemy się resztą.`;

  return {
    title: `${serviceName} ${cityName} – Helpfli`,
    metaTitle: `${serviceName} ${cityName} – sprawdzeni fachowcy | Helpfli`,
    metaDescription: `${serviceName} w ${cityName}. ${
      count ? `${count} zweryfikowanych wykonawców. ` : ''
    }Bezpłatna wycena. Helpfli – marketplace usług dla Twojego domu.`,
    intro,
    contentHtml:
      `<h2>Co warto wiedzieć</h2>` +
      `<ul>` +
      `<li>Wszyscy wykonawcy w Helpfli przechodzą weryfikację tożsamości.</li>` +
      `<li>Płacisz dopiero po wykonaniu pracy – Twoje pieniądze chroni system Helpfli Protect.</li>` +
      `<li>Oceny od prawdziwych klientów (tylko po zakończonym zleceniu).</li>` +
      `<li>Pomoc AI 24/7 – jeśli nie wiesz, kogo szukasz, AI zapyta i doradzi.</li>` +
      `</ul>`,
    faq: [
      {
        question: `Ile kosztuje ${serviceName.toLowerCase()} w ${cityName}?`,
        answer: median
          ? `Mediana ostatnich zleceń to około ${median} zł. Ostateczna cena zależy od zakresu pracy – zamów bezpłatną wycenę.`
          : `Ceny zależą od zakresu pracy – w Helpfli otrzymasz darmową, niezobowiązującą wycenę od kilku wykonawców.`
      },
      {
        question: `Jak szybko ktoś przyjedzie?`,
        answer: `Większość ofert pojawia się w ciągu kilku godzin, a w pilnych sprawach – minut. Zaznacz „pilne" przy zlecaniu pracy.`
      },
      {
        question: `Czy wykonawcy są sprawdzeni?`,
        answer: `Tak. Każdy wykonawca przechodzi weryfikację (KYC). Możesz też przeczytać opinie od poprzednich klientów.`
      }
    ]
  };
}

async function resolveService(serviceSlugRaw) {
  const input = String(serviceSlugRaw || '').toLowerCase().trim();
  if (!input) return null;

  const bySlugOrCode = await Service.findOne({
    $or: [{ slug: input }, { code: input }]
  }).lean();
  if (bySlugOrCode) return bySlugOrCode;

  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byName = await Service.findOne({
    $or: [
      { name_pl: { $regex: `^${escaped}$`, $options: 'i' } },
      { name: { $regex: `^${escaped}$`, $options: 'i' } },
      { slug: { $regex: `^${escaped}` } }
    ]
  }).lean();
  return byName;
}

async function buildOrUpdateLocalPage({ serviceSlug, citySlug, forceRegenerate = false }) {
  const city = TOP_PL_CITIES_BY_SLUG[citySlug?.toLowerCase()];
  if (!city) throw new Error(`Nieznane miasto: ${citySlug}`);

  const service = await resolveService(serviceSlug);
  if (!service) throw new Error(`Nieznana usługa: ${serviceSlug}`);

  const serviceName = service.name_pl || service.slug;
  const slug = `${service.slug}-${city.slug}`;

  const existing = await SeoLocalPage.findOne({
    serviceSlug: service.slug,
    citySlug: city.slug
  });
  if (existing && !forceRegenerate) {
    return existing;
  }

  const stats = await MarketplaceStats.getCityServiceSnapshot({
    citySlug: city.slug,
    serviceSlug: service.slug
  });

  let llmResult = null;
  try {
    llmResult = await callLLM({ serviceName, cityName: city.name, stats });
  } catch (err) {
    logger.warn?.('[SeoLocal] LLM call exception:', err.message);
  }

  const raw = llmResult?.raw || buildFallback({ serviceName, cityName: city.name, stats });
  const provider = llmResult?.provider || 'fallback';
  const model = llmResult?.model || null;

  const payload = {
    serviceSlug: service.slug,
    serviceName,
    citySlug: city.slug,
    cityName: city.name,
    slug,
    title: (raw.title || `${serviceName} ${city.name}`).slice(0, 160),
    metaTitle: (raw.metaTitle || `${serviceName} ${city.name} – Helpfli`).slice(0, 70),
    metaDescription: (raw.metaDescription || `${serviceName} w ${city.name} – Helpfli marketplace.`).slice(
      0,
      180
    ),
    intro: (raw.intro || '').slice(0, 1200),
    contentHtml: sanitizeArticleHtml(raw.contentHtml || ''),
    faq: Array.isArray(raw.faq)
      ? raw.faq
          .filter((f) => f && f.question && f.answer)
          .slice(0, 8)
          .map((f) => ({
            question: String(f.question).slice(0, 300),
            answer: String(f.answer).slice(0, 1500)
          }))
      : [],
    aiProvider: provider,
    aiModel: model,
    statsSnapshot: {
      providerCount: stats.providers?.count || 0,
      verifiedCount: stats.providers?.verifiedCount || 0,
      avgRating: stats.providers?.avgRating ?? null,
      medianPrice: stats.prices?.median ?? null,
      sampleSize: stats.prices?.sampleSize || 0,
      recentOrders30d: stats.recentOrders30d ?? null
    },
    lastBuiltAt: new Date(),
    published: true
  };

  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }
  return SeoLocalPage.create(payload);
}

module.exports = {
  buildOrUpdateLocalPage
};
