/**
 * Cron: buduje brakujące strony PSEO (usługa × miasto) w tle.
 *
 * Env:
 *   PSEO_CRON_MAX_BUILD=8        — ile par zbudować na jeden przebieg (default 8)
 *   PSEO_CRON_CITY_LIMIT=12      — top N miast po populacji
 *   PSEO_CRON_SERVICE_LIMIT=8    — top N usług z katalogu PSEO
 *   PSEO_CRON_ENABLED=1          — włącz (domyślnie wyłączone poza explicit 1)
 */
const mongoose = require('mongoose');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

function asInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function runPseoBulkCron(options = {}) {
  if (process.env.PSEO_CRON_ENABLED !== '1' && !options.force) {
    return { ok: true, skipped: true, reason: 'PSEO_CRON_ENABLED !== 1' };
  }

  if (mongoose.connection?.readyState !== 1) {
    const { connectMongoOnce } = require('../utils/mongoConnect');
    await connectMongoOnce();
  }
  if (mongoose.connection?.readyState !== 1) {
    return { ok: false, error: 'MongoDB not connected' };
  }

  const maxBuild = options.maxBuild ?? asInt(process.env.PSEO_CRON_MAX_BUILD, 8);
  const cityLimit = options.cityLimit ?? asInt(process.env.PSEO_CRON_CITY_LIMIT, 12);
  const serviceLimit = options.serviceLimit ?? asInt(process.env.PSEO_CRON_SERVICE_LIMIT, 8);

  const { SEO_CITIES, SEO_LOCAL_SERVICES } = require('../utils/seoCities');
  const SeoLocalPage = require('../models/SeoLocalPage');
  const { buildOrUpdateLocalPage } = require('../services/SeoLocalPageGenerator');
  const { getPublicBaseUrl } = require('../utils/publicUrl');

  let indexNow = null;
  try { indexNow = require('../services/IndexNowService'); } catch { /* optional */ }

  const cities = [...SEO_CITIES]
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .slice(0, cityLimit)
    .map((c) => c.slug);

  const services = SEO_LOCAL_SERVICES.slice(0, serviceLimit).map((s) => s.slug);

  const existing = await SeoLocalPage.find({
    serviceSlug: { $in: services },
    citySlug: { $in: cities },
    published: true
  })
    .select('serviceSlug citySlug')
    .lean();

  const existingSet = new Set(existing.map((p) => `${p.serviceSlug}:${p.citySlug}`));
  const missing = [];
  for (const svc of services) {
    for (const city of cities) {
      if (!existingSet.has(`${svc}:${city}`)) {
        missing.push({ service: svc, city });
      }
    }
  }

  const toBuild = missing.slice(0, maxBuild);
  const base = getPublicBaseUrl();
  const results = [];
  const indexNowUrls = [];

  for (const { service, city } of toBuild) {
    try {
      const page = await buildOrUpdateLocalPage({
        serviceSlug: service,
        citySlug: city,
        forceRegenerate: false
      });
      indexNowUrls.push(`${base}/wykonawcy/${page.serviceSlug}/${page.citySlug}`);
      results.push({ service, city, ok: true });
      await new Promise((r) => setTimeout(r, 600));
    } catch (err) {
      results.push({ service, city, ok: false, error: err.message });
      logger.warn?.('[PSEO CRON] build failed:', service, city, err.message);
    }
  }

  if (indexNow && indexNowUrls.length) {
    indexNow.submitBatch(indexNowUrls).catch(() => {});
  }

  const summary = {
    ok: true,
    missingTotal: missing.length,
    built: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  };
  logger.info?.('[PSEO CRON] done:', summary.built, 'built,', summary.failed, 'failed,', summary.missingTotal, 'remaining');
  return summary;
}

module.exports = { runPseoBulkCron };
