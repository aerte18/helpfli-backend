const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const { getConfig, setConfig } = require('../services/configService');
const { recomputeAllProviders } = require('../services/rankCache');
const { validateRankingConfig } = require('../services/configValidators');
const { writeConfigAudit } = require('../services/auditService');
const ConfigAudit = require('../models/ConfigAudit');

// GET bieżącej konfiguracji
router.get('/config/ranking', auth, async (_req, res) => {
  const cfg = await getConfig('ranking');
  res.json(cfg || {});
});

// PUT z walidacją + audyt
router.put('/config/ranking', auth, async (req, res) => {
  try {
    const incoming = req.body || {};
    const valid = validateRankingConfig(incoming);

    const before = (await getConfig('ranking')) || {};
    await setConfig('ranking', valid);

    try {
      await writeConfigAudit({
        key: 'ranking',
        userId: req.user?._id,
        before,
        after: valid,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || ''
      });
    } catch {}

    res.json({ ok: true, value: valid });
  } catch (e) {
    res.status(400).json({ message: e.message || 'Błąd walidacji konfiguracji.' });
  }
});

// POST — przelicz wszystkich
router.post('/ranking/recompute-all', auth, async (_req, res) => {
  const processed = await recomputeAllProviders(500);
  res.json({ ok: true, processed });
});

// GET — lista audit logów (ostatnie N)
router.get('/config/ranking/audit', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const items = await ConfigAudit.find({ key: 'ranking' })
    .populate('user', 'name email')
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json(items);
});

module.exports = router;





