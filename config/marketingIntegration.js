/**
 * Konfiguracja read-only API integracji marketingowej (AI Command Center).
 * Wartości można nadpisać zmiennymi środowiskowymi.
 */

function envInt(name, defaultVal) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

module.exports = {
  SCHEMA_VERSION: 'helpfli-marketing-data-v1',
  SOURCE_VERSION: process.env.MARKETING_INTEGRATION_SOURCE_VERSION || 'helpfli-backend-catalog-v1',

  privacyMinCount: envInt('MARKETING_INTEGRATION_PRIVACY_MIN_COUNT', 5),
  maxDateRangeDays: envInt('MARKETING_INTEGRATION_MAX_DATE_RANGE_DAYS', 90),
  maxCategoriesPerRequest: envInt('MARKETING_INTEGRATION_MAX_CATEGORIES', 20),
  maxLocationsPerRequest: envInt('MARKETING_INTEGRATION_MAX_LOCATIONS', 20),
  aggregationTimeoutMs: envInt('MARKETING_INTEGRATION_AGGREGATION_TIMEOUT_MS', 10000),
  cacheTtlSeconds: envInt('MARKETING_INTEGRATION_CACHE_TTL_SECONDS', 300),
  maxResponseBytes: envInt('MARKETING_INTEGRATION_MAX_RESPONSE_BYTES', 1024 * 1024),
  dataFreshnessSeconds: envInt('MARKETING_INTEGRATION_DATA_FRESHNESS_SECONDS', 300),

  rateLimitWindowMs: envInt('AI_COMMAND_CENTER_RATE_LIMIT_WINDOW_MS', 60 * 1000),
  rateLimitMax: envInt('AI_COMMAND_CENTER_RATE_LIMIT', 60),

  openOrderStatuses: ['open', 'collecting_offers'],
  terminalOrderStatuses: ['completed', 'rated', 'released', 'cancelled'],
  urgencyValues: ['now', 'today', 'tomorrow', 'this_week', 'flexible'],
};
