// Zarządzanie partnerami API (tylko dla adminów)
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const Partner = require('../models/Partner');
const { generateApiKey, generateApiSecret } = require('../middleware/partnerAuth');
const crypto = require('crypto');

// Wszystkie endpointy wymagają roli admin
router.use(authMiddleware, requireRole(['admin']));

// POST /api/admin/partners - Utwórz nowego partnera
router.post('/', async (req, res) => {
  try {
    const { name, email, company, permissions, rateLimit } = req.body;

    // Sprawdź czy partner z tym emailem już istnieje
    const existing = await Partner.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Partner z tym emailem już istnieje' });
    }

    // Generuj API Key i Secret
    const apiKey = generateApiKey();
    const apiSecret = generateApiSecret();
    const hashedSecret = crypto.createHash('sha256').update(apiSecret).digest('hex');

    const partner = await Partner.create({
      name,
      email,
      company,
      apiKey,
      apiSecret: hashedSecret,
      permissions: permissions || {
        readOrders: true,
        readProviders: true,
        readAnalytics: false,
        writeWebhooks: false
      },
      rateLimit: rateLimit || {
        requestsPerMinute: 60,
        requestsPerHour: 1000,
        requestsPerDay: 10000
      },
      status: 'pending',
      isActive: false,
      createdBy: req.user._id
    });

    // Zwróć API Key i Secret (tylko raz!)
    res.status(201).json({
      partner: {
        _id: partner._id,
        name: partner.name,
        email: partner.email,
        status: partner.status
      },
      credentials: {
        apiKey: partner.apiKey,
        apiSecret: apiSecret // Zwracamy tylko raz!
      },
      warning: 'Zapisz API Secret - nie będzie już dostępny!'
    });
  } catch (error) {
    console.error('CREATE_PARTNER_ERROR:', error);
    res.status(500).json({ message: 'Błąd tworzenia partnera' });
  }
});

// GET /api/admin/partners - Lista wszystkich partnerów
router.get('/', async (req, res) => {
  try {
    const partners = await Partner.find()
      .select('-apiSecret') // Nie zwracamy secret
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ partners });
  } catch (error) {
    console.error('GET_PARTNERS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania partnerów' });
  }
});

// GET /api/admin/partners/:partnerId - Szczegóły partnera
router.get('/:partnerId', async (req, res) => {
  try {
    const { partnerId } = req.params;
    
    const partner = await Partner.findById(partnerId)
      .select('-apiSecret')
      .populate('createdBy', 'name email');

    if (!partner) {
      return res.status(404).json({ message: 'Partner nie znaleziony' });
    }

    res.json({ partner });
  } catch (error) {
    console.error('GET_PARTNER_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania partnera' });
  }
});

// PATCH /api/admin/partners/:partnerId - Aktualizuj partnera
router.patch('/:partnerId', async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { name, email, company, status, isActive, permissions, rateLimit, notes } = req.body;

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({ message: 'Partner nie znaleziony' });
    }

    if (name) partner.name = name;
    if (email) partner.email = email;
    if (company) partner.company = company;
    if (status) partner.status = status;
    if (isActive !== undefined) partner.isActive = isActive;
    if (permissions) partner.permissions = { ...partner.permissions, ...permissions };
    if (rateLimit) partner.rateLimit = { ...partner.rateLimit, ...rateLimit };
    if (notes) partner.notes = notes;

    await partner.save();

    res.json({
      partner: {
        _id: partner._id,
        name: partner.name,
        email: partner.email,
        status: partner.status,
        isActive: partner.isActive,
        permissions: partner.permissions,
        rateLimit: partner.rateLimit
      }
    });
  } catch (error) {
    console.error('UPDATE_PARTNER_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktualizacji partnera' });
  }
});

// POST /api/admin/partners/:partnerId/regenerate-key - Regeneruj API Key
router.post('/:partnerId/regenerate-key', async (req, res) => {
  try {
    const { partnerId } = req.params;

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({ message: 'Partner nie znaleziony' });
    }

    // Generuj nowy API Key
    const newApiKey = generateApiKey();
    partner.apiKey = newApiKey;
    await partner.save();

    res.json({
      message: 'API Key został zregenerowany',
      apiKey: newApiKey,
      warning: 'Stary API Key przestanie działać!'
    });
  } catch (error) {
    console.error('REGENERATE_API_KEY_ERROR:', error);
    res.status(500).json({ message: 'Błąd regeneracji API Key' });
  }
});

// DELETE /api/admin/partners/:partnerId - Usuń partnera
router.delete('/:partnerId', async (req, res) => {
  try {
    const { partnerId } = req.params;

    const partner = await Partner.findByIdAndDelete(partnerId);
    if (!partner) {
      return res.status(404).json({ message: 'Partner nie znaleziony' });
    }

    // Usuń również webhooki partnera
    const Webhook = require('../models/Webhook');
    await Webhook.deleteMany({ partner: partnerId });

    res.json({ message: 'Partner został usunięty' });
  } catch (error) {
    console.error('DELETE_PARTNER_ERROR:', error);
    res.status(500).json({ message: 'Błąd usuwania partnera' });
  }
});

module.exports = router;













