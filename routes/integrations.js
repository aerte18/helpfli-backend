// Integracje zewnętrzne - kalendarze, płatności, API, webhooks
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const calendarService = require('../services/calendar_service');
const CalendarIntegration = require('../models/CalendarIntegration');
const User = require('../models/User');
const Order = require('../models/Order');

// ========== KALENDARZE ==========

function serializeCalendarIntegration(integration) {
  return {
    _id: integration._id,
    provider: integration.provider,
    email: integration.email,
    active: integration.active,
    autoSync: integration.autoSync,
    syncOrders: integration.syncOrders,
    syncOffers: integration.syncOffers,
    lastSyncAt: integration.lastSyncAt,
    lastSync: integration.lastSyncAt,
    syncError: integration.syncError,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt
  };
}

function getOrderStart(order) {
  if (order.scheduledDateTime) return order.scheduledDateTime;
  if (order.priorityDateTime) return order.priorityDateTime;
  const acceptedOffer = order.offers?.find(offer => String(offer._id) === String(order.acceptedOfferId));
  if (acceptedOffer?.date) return acceptedOffer.date;
  return null;
}

function getOrderEnd(order, start) {
  if (order.completedAt && order.completedAt > start) return order.completedAt;
  const durationMinutes = order.consultationDuration || 120;
  return new Date(start.getTime() + durationMinutes * 60 * 1000);
}

async function ensureFreshCalendarToken(integration) {
  let accessToken = integration.accessToken;
  if (!integration.tokenExpiresAt || integration.tokenExpiresAt >= new Date()) {
    return accessToken;
  }

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

  return accessToken;
}

async function createCalendarEvent(integration, accessToken, event) {
  if (integration.provider === 'google') {
    return calendarService.createGoogleEvent(accessToken, event);
  }
  if (integration.provider === 'outlook') {
    return calendarService.createOutlookEvent(accessToken, event);
  }
  throw new Error('Nieobsługiwany dostawca kalendarza');
}

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
 * GET /api/integrations/calendar - Lista integracji kalendarzowych użytkownika
 */
router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const integrations = await CalendarIntegration.find({ user: req.user._id, active: true })
      .sort({ createdAt: -1 });

    res.json({
      integrations: integrations.map(serializeCalendarIntegration),
      available: calendarService.getStatus()
    });
  } catch (err) {
    console.error('Calendar integrations error:', err);
    res.status(500).json({ message: 'Błąd pobierania integracji' });
  }
});

/**
 * GET /api/integrations/calendar/auth/:provider
 * Alias (np. starsze klienty /calendar/auth/outlook) — ta sama odpowiedź co …/:provider/auth-url.
 */
router.get('/calendar/auth/:provider', authMiddleware, async (req, res) => {
  try {
    const provider = String(req.params.provider || '').toLowerCase();
    if (provider !== 'google' && provider !== 'outlook') {
      return res.status(404).json({ error: 'Not found' });
    }
    const redirectUri = req.query.redirectUri || `${process.env.FRONTEND_URL || 'http://localhost:5181'}/integrations/calendar/callback`;
    const state = req.user._id.toString();
    const authUrl = provider === 'google'
      ? calendarService.getGoogleAuthUrl(redirectUri, state)
      : calendarService.getOutlookAuthUrl(redirectUri, state);
    res.json({ authUrl, state });
  } catch (err) {
    console.error('Calendar auth alias error:', err);
    res.status(500).json({ message: err.message || 'Błąd generowania URL autoryzacji' });
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
    const accessToken = await ensureFreshCalendarToken(integration);
    const startTime = getOrderStart(order) || order.createdAt;
    const endTime = getOrderEnd(order, startTime);

    // Przygotuj wydarzenie
    const event = {
      title: `Helpfli: ${order.title || order.service}`,
      description: order.description || '',
      startTime,
      endTime,
      location: order.location?.address || order.location?.city || '',
      attendees: isClient && order.provider?.email ? [order.provider.email] : 
                 isProvider && order.client?.email ? [order.client.email] : []
    };

    // Utwórz wydarzenie
    const calendarEvent = await createCalendarEvent(integration, accessToken, event);

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
 * POST /api/integrations/calendar/:integrationId/sync - Synchronizuj zlecenia providera z kalendarzem
 */
router.post('/calendar/:integrationId/sync', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const integration = await CalendarIntegration.findOne({
      _id: integrationId,
      user: req.user._id,
      active: true
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja kalendarzowa nie znaleziona' });
    }

    const orders = await Order.find({
      provider: req.user._id,
      status: { $in: ['accepted', 'in_progress'] }
    }).populate('client provider');

    const accessToken = await ensureFreshCalendarToken(integration);
    let synced = 0;
    let skipped = 0;

    for (const order of orders) {
      const alreadySynced = order.calendarEvents?.some(event => event.provider === integration.provider);
      const startTime = getOrderStart(order);

      if (alreadySynced || !startTime) {
        skipped += 1;
        continue;
      }

      const calendarEvent = await createCalendarEvent(integration, accessToken, {
        title: `Helpfli: ${order.title || order.service}`,
        description: order.description || '',
        startTime,
        endTime: getOrderEnd(order, startTime),
        location: order.location?.address || order.city || '',
        attendees: order.client?.email ? [order.client.email] : []
      });

      order.calendarEvents.push({
        provider: integration.provider,
        eventId: calendarEvent.id,
        syncedAt: new Date()
      });
      await order.save();
      synced += 1;
    }

    integration.lastSyncAt = new Date();
    integration.syncError = undefined;
    await integration.save();

    res.json({
      success: true,
      synced,
      skipped,
      integration: serializeCalendarIntegration(integration)
    });
  } catch (err) {
    console.error('Calendar bulk sync error:', err);
    try {
      await CalendarIntegration.findOneAndUpdate(
        { _id: req.params.integrationId, user: req.user._id },
        { syncError: err.message || 'Błąd synchronizacji' }
      );
    } catch {}
    res.status(500).json({ message: err.message || 'Błąd synchronizacji z kalendarzem' });
  }
});

/**
 * DELETE /api/integrations/calendar/:integrationIdOrProvider - Usuń integrację kalendarzową
 */
router.delete('/calendar/:integrationIdOrProvider', authMiddleware, async (req, res) => {
  try {
    const { integrationIdOrProvider } = req.params;
    const query = ['google', 'outlook'].includes(integrationIdOrProvider)
      ? { user: req.user._id, provider: integrationIdOrProvider }
      : { user: req.user._id, _id: integrationIdOrProvider };

    await CalendarIntegration.findOneAndUpdate(query, { active: false });

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













