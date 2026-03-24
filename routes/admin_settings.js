const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const Settings = require('../models/Settings');

// GET /api/admin/settings/:key
router.get('/:key', authMiddleware, requireRole('admin'), async (req, res) => {
  const doc = await Settings.findOne({ key: req.params.key });
  res.json({ key: req.params.key, value: doc?.value || {} });
});

// PUT /api/admin/settings/:key
router.put('/:key', authMiddleware, requireRole('admin'), async (req, res) => {
  const value = req.body?.value || {};
  await Settings.updateOne({ key: req.params.key }, { $set: { value } }, { upsert: true });
  res.json({ ok: true });
});

module.exports = router;






















