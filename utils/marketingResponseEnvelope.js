const cfg = require('../config/marketingIntegration');

function buildEnvelope(data, overrides = {}) {
  const generatedAt = new Date().toISOString();
  const freshnessSec = overrides.dataFreshnessSeconds ?? cfg.dataFreshnessSeconds;
  const expiresAt = new Date(Date.now() + freshnessSec * 1000).toISOString();

  return {
    schemaVersion: cfg.SCHEMA_VERSION,
    generatedAt,
    sourceVersion: overrides.sourceVersion || cfg.SOURCE_VERSION,
    dataFreshness: {
      ttlSeconds: freshnessSec,
      expiresAt,
    },
    data,
  };
}

function enforceMaxResponseSize(res, payload) {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > cfg.maxResponseBytes) {
    return {
      tooLarge: true,
      body: {
        error: 'response_too_large',
        message: 'Odpowiedź przekracza dozwolony rozmiar',
        maxBytes: cfg.maxResponseBytes,
      },
    };
  }
  return { tooLarge: false, body: payload, json };
}

module.exports = { buildEnvelope, enforceMaxResponseSize };
