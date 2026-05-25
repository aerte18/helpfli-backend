/**
 * Routes: /api/admin/content
 * --------------------------
 * Panel Marketing Automation (etap MVP — bez auto-publikacji).
 *
 *   GET    /api/admin/content                 lista (paginacja, filtry, sort)
 *   POST   /api/admin/content/generate        wygeneruj nową treść AI
 *   PATCH  /api/admin/content/:id             zmień pola (status, treść)
 *   DELETE /api/admin/content/:id             usuń
 *
 * Wszystkie endpointy są chronione: auth + rola admin/superadmin.
 */

const express = require('express');
const mongoose = require('mongoose');

const { authMiddleware } = require('../../middleware/authMiddleware');
const { requireRole } = require('../../middleware/roles');
const MarketingContent = require('../../models/MarketingContent');
const { generateAndStoreContent } = require('../../services/MarketingContentGenerator');

let logger;
try {
  logger = require('../../utils/logger');
} catch {
  logger = console;
}

const router = express.Router();

const ADMIN_ROLES = ['admin', 'superadmin'];

// auth + admin guard dla wszystkich endpointów
router.use(authMiddleware);
router.use(requireRole(ADMIN_ROLES));

// pola, które admin może edytować ręcznie
const EDITABLE_FIELDS = [
  'title',
  'category',
  'contentType',
  'platform',
  'status',
  'hook',
  'content',
  'cta',
  'hashtags',
  'videoFormat',
  'topic',
  'externalPostId',
  'scheduledAt',
  'publishedAt',
  'publishError'
];

function pickEditable(body = {}) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      out[k] = body[k];
    }
  }
  if (Array.isArray(out.hashtags)) {
    out.hashtags = out.hashtags
      .map((h) => String(h || '').replace(/^#+/, '').trim())
      .filter(Boolean)
      .slice(0, 30);
  }
  return out;
}

/**
 * GET /api/admin/content
 *   ?page, ?limit, ?status, ?category, ?platform, ?contentType, ?q
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.status && MarketingContent.STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
    }
    if (req.query.category && MarketingContent.CATEGORIES.includes(req.query.category)) {
      query.category = req.query.category;
    }
    if (req.query.platform && MarketingContent.PLATFORMS.includes(req.query.platform)) {
      query.platform = req.query.platform;
    }
    if (req.query.contentType && MarketingContent.CONTENT_TYPES.includes(req.query.contentType)) {
      query.contentType = req.query.contentType;
    }
    if (req.query.q && String(req.query.q).trim().length >= 2) {
      const rx = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ title: rx }, { topic: rx }, { hook: rx }, { content: rx }];
    }

    const [items, total] = await Promise.all([
      MarketingContent.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MarketingContent.countDocuments(query)
    ]);

    res.json({
      ok: true,
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      },
      meta: {
        categories: MarketingContent.CATEGORIES,
        contentTypes: MarketingContent.CONTENT_TYPES,
        platforms: MarketingContent.PLATFORMS,
        statuses: MarketingContent.STATUSES
      }
    });
  } catch (err) {
    logger.error?.('[admin/content] GET error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania treści' });
  }
});

/**
 * POST /api/admin/content/generate
 *   body: { category, contentType, platform, topic, extra? }
 */
router.post('/generate', async (req, res) => {
  try {
    const { category, contentType, platform, topic, extra } = req.body || {};

    if (!category || !contentType || !platform || !topic) {
      return res.status(400).json({
        ok: false,
        message: 'Wymagane pola: category, contentType, platform, topic'
      });
    }

    const result = await generateAndStoreContent({
      category,
      contentType,
      platform,
      topic,
      extra: extra && typeof extra === 'object' ? extra : {},
      createdBy: req.user?._id || null
    });

    res.status(201).json({
      ok: true,
      provider: result.provider,
      model: result.model,
      item: result.item
    });
  } catch (err) {
    logger.error?.('[admin/content] /generate error:', err);
    res.status(400).json({ ok: false, message: err.message || 'Błąd generowania treści' });
  }
});

/**
 * PATCH /api/admin/content/:id
 *   body: { status?, content?, hook?, cta?, hashtags?, ... }
 *
 * Specjalne skróty:
 *   - jeśli body.status === 'published' i nie ma publishedAt, ustawia datę,
 *   - jeśli body.status !== 'published', kasuje publishedAt (chyba że
 *     publishedAt zostało jawnie podane w body).
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'Nieprawidłowe ID' });
    }

    const patch = pickEditable(req.body || {});

    if (
      patch.status === 'published' &&
      !Object.prototype.hasOwnProperty.call(patch, 'publishedAt')
    ) {
      patch.publishedAt = new Date();
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'status') &&
      patch.status !== 'published' &&
      !Object.prototype.hasOwnProperty.call(req.body || {}, 'publishedAt')
    ) {
      patch.publishedAt = null;
    }

    const item = await MarketingContent.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true
    }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: 'Nie znaleziono treści' });
    }
    res.json({ ok: true, item });
  } catch (err) {
    logger.error?.('[admin/content] PATCH error:', err);
    res.status(400).json({ ok: false, message: err.message || 'Błąd aktualizacji' });
  }
});

/**
 * DELETE /api/admin/content/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'Nieprawidłowe ID' });
    }
    const removed = await MarketingContent.findByIdAndDelete(id).lean();
    if (!removed) {
      return res.status(404).json({ ok: false, message: 'Nie znaleziono treści' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error?.('[admin/content] DELETE error:', err);
    res.status(500).json({ ok: false, message: 'Błąd usuwania' });
  }
});

module.exports = router;
