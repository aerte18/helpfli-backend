// Zarządzanie webhookami dla partnerów
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const { partnerAuth, requirePartnerPermission } = require('../middleware/partnerAuth');
const Webhook = require('../models/Webhook');
const Partner = require('../models/Partner');
const crypto = require('crypto');

// Endpointy dla adminów (zarządzanie webhookami partnerów)
// POST /api/admin/partners/:partnerId/webhooks - Utwórz webhook dla partnera
router.post('/admin/partners/:partnerId/webhooks', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { url, events, timeout, retries } = req.body;

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Partner nie znaleziony' });
    }

    // Sprawdź czy partner ma uprawnienia do webhooków
    if (!partner.permissions.writeWebhooks) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Partner nie ma uprawnień do webhooków' });
    }

    // Generuj secret
    const secret = crypto.randomBytes(32).toString('hex');

    const webhook = await Webhook.create({
      partner: partnerId,
      url,
      events: Array.isArray(events) ? events : [events],
      secret,
      config: {
        timeout: timeout || 30000,
        retries: retries || 3,
        retryDelay: 1000
      }
    });

    res.status(201).json({
      webhook: {
        _id: webhook._id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive,
        createdAt: webhook.createdAt
        // Nie zwracamy secret!
      }
    });
  } catch (error) {
    console.error('CREATE_WEBHOOK_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd tworzenia webhooka' });
  }
});

// GET /api/admin/partners/:partnerId/webhooks - Lista webhooków partnera
router.get('/admin/partners/:partnerId/webhooks', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { partnerId } = req.params;
    
    const webhooks = await Webhook.find({ partner: partnerId })
      .select('-secret') // Nie zwracamy secret
      .sort({ createdAt: -1 });

    res.json({ webhooks });
  } catch (error) {
    console.error('GET_WEBHOOKS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania webhooków' });
  }
});

// PATCH /api/admin/partners/:partnerId/webhooks/:webhookId - Aktualizuj webhook
router.patch('/admin/partners/:partnerId/webhooks/:webhookId', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { partnerId, webhookId } = req.params;
    const { url, events, isActive, timeout, retries } = req.body;

    const webhook = await Webhook.findOne({ _id: webhookId, partner: partnerId });
    if (!webhook) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Webhook nie znaleziony' });
    }

    if (url) webhook.url = url;
    if (events) webhook.events = Array.isArray(events) ? events : [events];
    if (isActive !== undefined) webhook.isActive = isActive;
    if (timeout) webhook.config.timeout = timeout;
    if (retries) webhook.config.retries = retries;

    await webhook.save();

    res.json({
      webhook: {
        _id: webhook._id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive,
        stats: webhook.stats
      }
    });
  } catch (error) {
    console.error('UPDATE_WEBHOOK_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd aktualizacji webhooka' });
  }
});

// DELETE /api/admin/partners/:partnerId/webhooks/:webhookId - Usuń webhook
router.delete('/admin/partners/:partnerId/webhooks/:webhookId', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { partnerId, webhookId } = req.params;

    const webhook = await Webhook.findOneAndDelete({ _id: webhookId, partner: partnerId });
    if (!webhook) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Webhook nie znaleziony' });
    }

    res.json({ message: 'Webhook usunięty' });
  } catch (error) {
    console.error('DELETE_WEBHOOK_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd usuwania webhooka' });
  }
});

// GET /api/partner/webhooks - Lista webhooków (dla partnera przez API)
router.get('/partner/webhooks', partnerAuth, async (req, res) => {
  try {
    const webhooks = await Webhook.find({ partner: req.partner._id })
      .select('-secret') // Nie zwracamy secret
      .sort({ createdAt: -1 });

    res.json({ webhooks });
  } catch (error) {
    console.error('PARTNER_GET_WEBHOOKS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania webhooków' });
  }
});

// GET /api/partner/webhooks/:webhookId/stats - Statystyki webhooka
router.get('/partner/webhooks/:webhookId/stats', partnerAuth, async (req, res) => {
  try {
    const { webhookId } = req.params;

    const webhook = await Webhook.findOne({ _id: webhookId, partner: req.partner._id });
    if (!webhook) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Webhook nie znaleziony' });
    }

    res.json({
      webhook: {
        _id: webhook._id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive
      },
      stats: webhook.stats
    });
  } catch (error) {
    console.error('WEBHOOK_STATS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania statystyk' });
  }
});

module.exports = router;













