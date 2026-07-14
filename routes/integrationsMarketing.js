/**
 * Read-only Marketing Integration API v1 — AI Command Center.
 *
 * Prefix: /api/integrations/marketing/v1
 * (ACC obecnie oczekuje ścieżek bez /v1 — wymaga aktualizacji HELPFLI_API_BASE_URL lub path mapping)
 */

const express = require('express');
const { aiCommandCenterAuth } = require('../middleware/aiCommandCenterAuth');
const { marketingIntegrationRateLimiter } = require('../middleware/marketingIntegrationRateLimiter');
const { buildEnvelope, enforceMaxResponseSize } = require('../utils/marketingResponseEnvelope');
const MarketingReadService = require('../services/MarketingReadService');
const { getPlatformFacts } = require('../services/MarketingPlatformFactsService');
const cfg = require('../config/marketingIntegration');

const router = express.Router();

router.use(aiCommandCenterAuth);
router.use(marketingIntegrationRateLimiter);

function sendEnvelope(res, data, overrides = {}) {
  const payload = buildEnvelope(data, overrides);
  const check = enforceMaxResponseSize(res, payload);
  if (check.tooLarge) {
    return res.status(413).json(check.body);
  }
  return res.json(check.body);
}

function handleServiceError(res, err) {
  if (err?.message === 'aggregation_timeout') {
    return res.status(504).json({
      error: 'aggregation_timeout',
      message: 'Przekroczono limit czasu agregacji',
    });
  }
  return res.status(500).json({
    error: 'internal_error',
    message: 'Błąd wewnętrzny integracji marketingowej',
  });
}

/** GET /catalog */
router.get('/catalog', async (_req, res) => {
  try {
    const { categories, sourceVersion } = await MarketingReadService.getCatalog();
    return sendEnvelope(
      res,
      { categories },
      { sourceVersion }
    );
  } catch (err) {
    return handleServiceError(res, err);
  }
});

/** POST /demand-summary */
router.post('/demand-summary', async (req, res) => {
  try {
    const result = await MarketingReadService.getDemandSummary(req.body || {});
    if (result.errors?.length) {
      const primary = result.errors[0];
      const status =
        primary.code === 'date_range_too_large'
          ? 400
          : primary.code === 'unsupported_location' || primary.code === 'unsupported_category'
            ? 422
            : 400;
      return res.status(status).json({
        error: primary.code,
        message: primary.message,
        details: result.errors,
      });
    }
    return sendEnvelope(res, result.data);
  } catch (err) {
    return handleServiceError(res, err);
  }
});

/** POST /supply-summary */
router.post('/supply-summary', async (req, res) => {
  try {
    const result = await MarketingReadService.getSupplySummary(req.body || {});
    if (result.errors?.length) {
      const primary = result.errors[0];
      const status =
        primary.code === 'unsupported_location' || primary.code === 'unsupported_category'
          ? 422
          : 400;
      return res.status(status).json({
        error: primary.code,
        message: primary.message,
        details: result.errors,
      });
    }
    return sendEnvelope(res, result.data);
  } catch (err) {
    return handleServiceError(res, err);
  }
});

/** GET /platform-facts */
router.get('/platform-facts', (_req, res) => {
  try {
    const facts = getPlatformFacts();
    return sendEnvelope(res, {
      facts,
      verifiedCount: facts.filter((f) => f.verified).length,
      unverifiedCount: facts.filter((f) => !f.verified).length,
    });
  } catch (err) {
    return handleServiceError(res, err);
  }
});

/** GET /claims */
router.get('/claims', (_req, res) => {
  try {
    const registry = MarketingReadService.getClaimsRegistry();
    const byStatus = { verified: 0, unverified: 0, forbidden: 0 };
    for (const c of registry.claims || []) {
      if (byStatus[c.status] != null) byStatus[c.status] += 1;
    }
    return sendEnvelope(res, {
      registryVersion: registry.registryVersion,
      updatedAt: registry.updatedAt,
      claims: registry.claims,
      counts: byStatus,
    });
  } catch (err) {
    if (String(err.message || '').startsWith('duplicate_claim_code')) {
      return res.status(500).json({
        error: 'claims_registry_invalid',
        message: 'Duplikat kodu w rejestrze claims',
      });
    }
    return handleServiceError(res, err);
  }
});

/** GET /health — smoke bez danych biznesowych */
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    schemaVersion: cfg.SCHEMA_VERSION,
    scope: 'marketing_read_only',
  });
});

module.exports = router;
