// Integracje zewnętrzne - kalendarze, płatności, API, webhooks
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const calendarService = require('../services/calendar_service');
const CalendarIntegration = require('../models/CalendarIntegration');
const User = require('../models/User');
const Order = require('../models/Order');

// ========== KALENDARZE ==========

/**
 * GET /api/integrations/calendar/status - Status integracji kalendarzowych
 */
router.get('/calendar/status', authMiddleware, async (req, res) => {
  try {
    const integrations = await CalendarIntegration.find({ user: req.user._id, active: true });
    const status = calendarService.getStatus();

    res.json({
      available: status,
      connected: integrations.map(i => ({
        provider: i.provider,
        email: i.email,
        autoSync: i.autoSync,
        lastSyncAt: i.lastSyncAt
      }))
    });
  } catch (err) {
    console.error('Calendar status error:', err);
    res.status(500).json({ message: 'Błąd pobierania statusu' });
  }
});

/**
 * GET /api/integrations/calendar/google/auth-url - URL autoryzacji Google
 */
router.get('/calendar/google/auth-url', authMiddleware, async (req, res) => {
  try {
    const redirectUri = req.query.redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:5181'}/integrations/calendar/callback`;
    const state = req.user._id.toString();

    const authUrl = calendarService.getGoogleAuthUrl(redirectUri, state);
    res.json({ authUrl, state });
  } catch (err) {
    console.error('Google auth URL error:', err);
    res.status(500).json({ message: err.message || 'Błąd generowania URL autoryzacji' });
  }
});

/**
 * POST /api/integrations/calendar/google/callback - Callback po autoryzacji Google
 */
router.post('/calendar/google/callback', authMiddleware, async (req, res) => {
  try {
    const { code, redirectUri } = req.body;

    if (!code) {
      return res.status(400).json({ message: 'Brak kodu autoryzacji' });
    }

    const tokens = await calendarService.exchangeGoogleCode(
      code,
      redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:5181'}/integrations/calendar/callback`
    );

    // Pobierz informacje o użytkowniku Google
    const userInfo = await getUserInfoFromGoogle(tokens.accessToken);

    // Zapisz integrację
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokens.expiresIn);

    const integration = await CalendarIntegration.findOneAndUpdate(
      { user: req.user._id, provider: 'google' },
      {
        user: req.user._id,
        provider: 'google',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: expiresAt,
        email: userInfo.email,
        active: true,
        lastSyncAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, integration });
  } catch (err) {
    console.error('Google callback error:', err);
    res.status(500).json({ message: err.message || 'Błąd autoryzacji Google' });
  }
});

/**
 * GET /api/integrations/calendar/outlook/auth-url - URL autoryzacji Outlook
 */
router.get('/calendar/outlook/auth-url', authMiddleware, async (req, res) => {
  try {
    const redirectUri = req.query.redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:5181'}/integrations/calendar/callback`;
    const state = req.user._id.toString();

    const authUrl = calendarService.getOutlookAuthUrl(redirectUri, state);
    res.json({ authUrl, state });
  } catch (err) {
    console.error('Outlook auth URL error:', err);
    res.status(500).json({ message: err.message || 'Błąd generowania URL autoryzacji' });
  }
});

/**
 * POST /api/integrations/calendar/outlook/callback - Callback po autoryzacji Outlook
 */
router.post('/calendar/outlook/callback', authMiddleware, async (req, res) => {
  try {
    const { code, redirectUri } = req.body;

    if (!code) {
      return res.status(400).json({ message: 'Brak kodu autoryzacji' });
    }

    const tokens = await calendarService.exchangeOutlookCode(
      code,
      redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:5181'}/integrations/calendar/callback`
    );

    // Pobierz informacje o użytkowniku Outlook
    const userInfo = await getUserInfoFromOutlook(tokens.accessToken);

    // Zapisz integrację
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokens.expiresIn);

    const integration = await CalendarIntegration.findOneAndUpdate(
      { user: req.user._id, provider: 'outlook' },
      {
        user: req.user._id,
        provider: 'outlook',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: expiresAt,
        email: userInfo.email,
        active: true,
        lastSyncAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, integration });
  } catch (err) {
    console.error('Outlook callback error:', err);
    res.status(500).json({ message: err.message || 'Błąd autoryzacji Outlook' });
  }
});

/**
 * POST /api/integrations/calendar/sync-order - Synchronizuj zlecenie z kalendarzem
 */
router.post('/calendar/sync-order', authMiddleware, async (req, res) => {
  try {
    const { orderId, provider } = req.body; // provider: 'google' | 'outlook'

    const order = await Order.findById(orderId).populate('client provider');
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    // Sprawdź czy użytkownik ma dostęp do zlecenia
    const isClient = String(order.client._id) === String(req.user._id);
    const isProvider = order.provider && String(order.provider._id) === String(req.user._id);

    if (!isClient && !isProvider) {
      return res.status(403).json({ message: 'Brak dostępu do zlecenia' });
    }

    // Pobierz integrację kalendarzową
    const integration = await CalendarIntegration.findOne({
      user: req.user._id,
      provider: provider || 'google',
      active: true
    });

    if (!integration) {
      return res.status(404).json({ message: 'Brak aktywnej integracji kalendarzowej' });
    }

    // Odśwież token jeśli wygasł
    let accessToken = integration.accessToken;
    if (integration.tokenExpiresAt && integration.tokenExpiresAt < new Date()) {
      if (integration.provider === 'google') {
        const refreshed = await calendarService.refreshGoogleToken(integration.refreshToken);
        accessToken = refreshed.accessToken;
        integration.accessToken = accessToken;
        integration.tokenExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
        await integration.save();
      } else if (integration.provider === 'outlook') {
        const refreshed = await calendarService.refreshOutlookToken(integration.refreshToken);
        accessToken = refreshed.accessToken;
        integration.accessToken = accessToken;
        integration.tokenExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
        await integration.save();
      }
    }

    // Przygotuj wydarzenie
    const event = {
      title: `Helpfli: ${order.title || order.service}`,
      description: order.description || '',
      startTime: order.scheduledAt || order.createdAt,
      endTime: order.completedAt || new Date(order.scheduledAt?.getTime() + 2 * 60 * 60 * 1000) || new Date(order.createdAt.getTime() + 2 * 60 * 60 * 1000),
      location: order.location?.address || order.location?.city || '',
      attendees: isClient && order.provider?.email ? [order.provider.email] : 
                 isProvider && order.client?.email ? [order.client.email] : []
    };

    // Utwórz wydarzenie
    let calendarEvent;
    if (integration.provider === 'google') {
      calendarEvent = await calendarService.createGoogleEvent(accessToken, event);
    } else if (integration.provider === 'outlook') {
      calendarEvent = await calendarService.createOutlookEvent(accessToken, event);
    }

    // Zaktualizuj zlecenie
    if (!order.calendarEvents) order.calendarEvents = [];
    order.calendarEvents.push({
      provider: integration.provider,
      eventId: calendarEvent.id,
      syncedAt: new Date()
    });
    await order.save();

    // Zaktualizuj ostatnią synchronizację
    integration.lastSyncAt = new Date();
    await integration.save();

    res.json({ success: true, calendarEvent, orderId });
  } catch (err) {
    console.error('Calendar sync error:', err);
    res.status(500).json({ message: err.message || 'Błąd synchronizacji z kalendarzem' });
  }
});

/**
 * DELETE /api/integrations/calendar/:provider - Usuń integrację kalendarzową
 */
router.delete('/calendar/:provider', authMiddleware, async (req, res) => {
  try {
    const { provider } = req.params;

    await CalendarIntegration.findOneAndUpdate(
      { user: req.user._id, provider },
      { active: false }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Delete calendar integration error:', err);
    res.status(500).json({ message: 'Błąd usuwania integracji' });
  }
});

// ========== PŁATNOŚCI (BLIK, Przelewy24) ==========

/**
 * GET /api/integrations/payments/methods - Dostępne metody płatności
 */
router.get('/payments/methods', async (req, res) => {
  try {
    res.json({
      methods: [
        {
          id: 'card',
          name: 'Karta płatnicza',
          enabled: true,
          icon: '💳'
        },
        {
          id: 'p24',
          name: 'Przelewy24',
          enabled: !!process.env.P24_MERCHANT_ID,
          icon: '🏦'
        },
        {
          id: 'blik',
          name: 'BLIK',
          enabled: true, // BLIK jest obsługiwany przez Stripe
          icon: '📱'
        }
      ]
    });
  } catch (err) {
    console.error('Payment methods error:', err);
    res.status(500).json({ message: 'Błąd pobierania metod płatności' });
  }
});

// ========== API DLA PARTNERÓW ==========

/**
 * POST /api/integrations/partners/register - Rejestracja partnera API
 */
router.post('/partners/register', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Tylko administratorzy mogą rejestrować partnerów API' });
    }

    const { name, description, webhookUrl, allowedEndpoints } = req.body;

    // Generuj API key
    const apiKey = generateApiKey();

    // Zapisz partnera (można użyć osobnego modelu Partner)
    // Na razie użyjemy User z dodatkowym polem
    const partner = await User.create({
      name,
      email: `partner-${Date.now()}@helpfli.pl`,
      password: 'not-used',
      role: 'partner',
      apiKey,
      partnerConfig: {
        name,
        description,
        webhookUrl,
        allowedEndpoints: allowedEndpoints || [],
        active: true
      }
    });

    res.status(201).json({
      partnerId: partner._id,
      apiKey,
      message: 'Partner zarejestrowany pomyślnie'
    });
  } catch (err) {
    console.error('Partner registration error:', err);
    res.status(500).json({ message: 'Błąd rejestracji partnera' });
  }
});

// ========== WEBHOOKS ==========

/**
 * POST /api/integrations/webhooks - Utwórz webhook
 */
router.post('/webhooks', authMiddleware, async (req, res) => {
  try {
    const { url, events, secret } = req.body;

    if (!url || !events || !Array.isArray(events)) {
      return res.status(400).json({ message: 'Brakuje wymaganych pól' });
    }

    // Generuj webhook ID i secret
    const webhookId = generateWebhookId();
    const webhookSecret = secret || generateWebhookSecret();

    // Zapisz webhook (można użyć osobnego modelu Webhook)
    // Na razie zwróć informacje
    res.status(201).json({
      webhookId,
      webhookSecret,
      url,
      events,
      active: true,
      message: 'Webhook utworzony pomyślnie'
    });
  } catch (err) {
    console.error('Webhook creation error:', err);
    res.status(500).json({ message: 'Błąd tworzenia webhooka' });
  }
});

// Helper functions

async function getUserInfoFromGoogle(accessToken) {
  const axios = require('axios');
  try {
    const response = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    return { email: response.data.email, name: response.data.name };
  } catch (error) {
    throw new Error('Failed to get Google user info');
  }
}

async function getUserInfoFromOutlook(accessToken) {
  const axios = require('axios');
  try {
    const response = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    return { email: response.data.mail || response.data.userPrincipalName, name: response.data.displayName };
  } catch (error) {
    throw new Error('Failed to get Outlook user info');
  }
}

function generateApiKey() {
  return `qks_${require('crypto').randomBytes(32).toString('hex')}`;
}

function generateWebhookId() {
  return `wh_${require('crypto').randomBytes(16).toString('hex')}`;
}

function generateWebhookSecret() {
  return require('crypto').randomBytes(32).toString('hex');
}

module.exports = router;













