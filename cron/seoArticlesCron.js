/**
 * CRON: SEO Articles Auto-Generation
 * ----------------------------------
 * Co noc (domyślnie 03:30) wybiera N tematów z seed listy, których jeszcze
 * nie ma w bazie, i generuje pełne poradniki. Domyślnie zapisuje je jako
 * `published=false` (draft), żeby admin mógł zaakceptować — zgodnie z radą
 * „nie róbmy 1000 stron, Google lubi jakość".
 *
 * Włączenie:
 *   - ENABLE_JOBS=1
 *   - SEO_AUTO_GENERATE=1
 *   - (opcjonalnie) SEO_CRON_COUNT=5
 *   - (opcjonalnie) SEO_CRON_SCHEDULE="30 3 * * *"
 *   - (opcjonalnie) SEO_CRON_AUTO_PUBLISH=1  ← publikuj od razu (NIE zalecane)
 *
 * Wbudowany kill-switch: jeśli aktualnie w bazie jest > SEO_CRON_HARD_CAP
 * artykułów (domyślnie 500), cron przestaje generować — żeby nie zaśmiecać
 * bazy w razie zapętlenia.
 */

const cron = require('node-cron');
const SeoArticle = require('../models/SeoArticle');
const { SEO_SEED_TOPICS } = require('../utils/seoTopics');
const { generateAndStoreArticle } = require('../services/SeoArticleGenerator');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

function asInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function runSeoGenerationOnce({ count, publish }) {
  const startedAt = Date.now();
  const hardCap = asInt(process.env.SEO_CRON_HARD_CAP, 500);
  const current = await SeoArticle.estimatedDocumentCount();
  if (current >= hardCap) {
    logger.info?.(
      `[SEO CRON] Skip – ${current} artykułów już istnieje (hard cap ${hardCap}). ` +
      'Podnieś SEO_CRON_HARD_CAP, jeśli chcesz więcej.'
    );
    return { skipped: true, reason: 'hard_cap', count: 0 };
  }

  const existing = await SeoArticle.find({}).select('topic').lean();
  const taken = new Set(existing.map((a) => String(a.topic || '').toLowerCase()));
  const queue = SEO_SEED_TOPICS
    .filter((t) => !taken.has(t.topic.toLowerCase()))
    .slice(0, count);

  if (queue.length === 0) {
    logger.info?.('[SEO CRON] Seed lista wyczerpana. Dodaj nowe tematy w `backend/utils/seoTopics.js`.');
    return { skipped: true, reason: 'empty_seed', count: 0 };
  }

  const results = [];
  for (const t of queue) {
    try {
      const r = await generateAndStoreArticle({
        topic: t.topic,
        hints: { category: t.category, keywords: t.keywords || [] },
        publish: !!publish,
        generatedBy: null
      });
      results.push({
        topic: t.topic,
        ok: true,
        created: r.created,
        slug: r.article.slug,
        provider: r.provider
      });
    } catch (err) {
      results.push({ topic: t.topic, ok: false, error: err.message });
      logger.warn?.(`[SEO CRON] Błąd dla "${t.topic}": ${err.message}`);
    }
    // throttling – nie wbijaj rate limitów LLM
    await new Promise((r2) => setTimeout(r2, 1500));
  }

  const okCount = results.filter((r) => r.ok).length;
  logger.info?.(
    `[SEO CRON] Wygenerowano ${okCount}/${queue.length} poradników w ${Date.now() - startedAt}ms ` +
    `(${publish ? 'opublikowane' : 'jako drafty'}).`
  );

  return { skipped: false, count: okCount, results };
}

function startSeoArticlesCron() {
  if (process.env.SEO_AUTO_GENERATE !== '1') {
    logger.info?.('[SEO CRON] Wyłączony (ustaw SEO_AUTO_GENERATE=1, żeby włączyć).');
    return null;
  }

  const schedule = process.env.SEO_CRON_SCHEDULE || '30 3 * * *'; // 03:30 każdej nocy
  const count = asInt(process.env.SEO_CRON_COUNT, 5);
  const publish = process.env.SEO_CRON_AUTO_PUBLISH === '1';

  if (!cron.validate(schedule)) {
    logger.error?.(`[SEO CRON] Niepoprawny SEO_CRON_SCHEDULE: "${schedule}". Pomijam.`);
    return null;
  }

  const task = cron.schedule(
    schedule,
    async () => {
      try {
        logger.info?.(`[SEO CRON] Start (${count} tematów, publish=${publish})`);
        await runSeoGenerationOnce({ count, publish });
      } catch (err) {
        logger.error?.('[SEO CRON] Niepowodzenie zadania:', err);
      }
    },
    { timezone: process.env.SEO_CRON_TZ || 'Europe/Warsaw' }
  );

  logger.info?.(
    `[SEO CRON] Zaplanowany: "${schedule}" (TZ ${process.env.SEO_CRON_TZ || 'Europe/Warsaw'}), ` +
    `count=${count}, auto-publish=${publish}.`
  );
  return task;
}

module.exports = {
  startSeoArticlesCron,
  runSeoGenerationOnce
};
