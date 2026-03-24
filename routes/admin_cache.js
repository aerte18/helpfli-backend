const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const cache = require('../utils/cache');

// GET /api/admin/cache/info
router.get('/info', authMiddleware, requireRole('admin'), async (_req, res) => {
  const data = await cache.info();
  res.json(data);
});

// POST /api/admin/cache/flush  (body: { prefix?: string, all?: boolean })
router.post('/flush', authMiddleware, requireRole('admin'), async (req, res) => {
  const prefix = (req.body?.prefix || req.query?.prefix || '').trim();
  const all = String(req.body?.all ?? req.query?.all ?? 'false') === 'true';

  if (!all && !prefix) {
    return res.status(400).json({ message: 'Podaj prefix albo ustaw all=true' });
  }
  try {
    if (all) {
      const r = await cache.flushAll();
      return res.json({ ok: true, mode: 'all', ...r });
    } else {
      const r = await cache.delPrefix(prefix);
      return res.json({ ok: true, mode: 'prefix', prefix, ...r });
    }
  } catch (e) {
    console.error('[cache.flush] error', e);
    return res.status(500).json({ message: 'Błąd czyszczenia cache', error: e.message });
  }
});

module.exports = router;






















