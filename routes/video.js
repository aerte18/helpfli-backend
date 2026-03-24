?const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const { authMiddleware } = require('../middleware/authMiddleware');
const VideoSession = require('../models/VideoSession');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Order = require('../models/Order');
const { createRoom, createToken, getRoom, deleteRoom, getRecordings, isConfigured } = require('../services/dailyService');

const CURRENCY = process.env.CURRENCY || 'pln';

// GET /api/video/sessions - lista sesji użytkownika
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status } = req.query;

    const query = {
      $or: [
        { client: userId },
        { provider: userId }
      ]
    };

    if (status) {
      query.status = status;
    }

    const sessions = await VideoSession.find(query)
      .populate('client', 'name email avatar')
      .populate('provider', 'name email avatar')
      .populate('order', 'service description')
      .sort({ scheduledAt: -1 })
      .limit(50)
      .lean();

    res.json({ sessions });
  } catch (error) {
    console.error('GET_VIDEO_SESSIONS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania sesji wideo' });
  }
});

// POST /api/video/sessions/create-payment-intent - utworzenie PaymentIntent dla wideo-wizyty
router.post('/sessions/create-payment-intent', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Płatności Stripe nie są skonfigurowane' });
    }

    const { providerId, orderId, price } = req.body;
    const clientId = req.user._id;

    if (!providerId) {
      return res.status(400).json({ message: 'providerId jest wymagany' });
    }

    if (!price || price <= 0) {
      return res.status(400).json({ message: 'Cena musi być większa od 0' });
    }

    const provider = await User.findById(providerId);
    if (!provider || provider.role !== 'provider') {
      return res.status(404).json({ message: 'Wykonawca nie został znaleziony' });
    }

    // Sprawdź czy zlecenie istnieje (jeśli podano)
    if (orderId) {
      const order = await Order.findById(orderId);
      if (!order) {
        return res.status(404).json({ message: 'Zlecenie nie zostało znalezione' });
      }
      if (String(order.client) !== String(clientId)) {
        return res.status(403).json({ message: 'Nie masz uprawnień do tego zlecenia' });
      }
    }

    const amount = Math.round(price * 100); // Konwersja na grosze

    // Utwórz PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: CURRENCY,
      payment_method_types: ['card', 'p24', 'blik'],
      description: `Helpfli Wideo-wizyta z ${provider.name}`,
      metadata: {
        type: 'video',
        providerId: String(providerId),
        clientId: String(clientId),
        orderId: orderId ? String(orderId) : '',
        amount: String(amount),
      },
      statement_descriptor: 'HELPFLI VIDEO',
    });

    // Zapisz Payment (pending)
    const payment = await Payment.create({
      purpose: 'video',
      provider: providerId,
      client: clientId,
      providerName: provider.name || provider.email,
      clientName: req.user.name || req.user.email,
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: 'unknown',
      status: intent.status,
      metadata: intent.metadata,
    });

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      paymentId: payment._id,
      amount: price,
    });
  } catch (error) {
    console.error('CREATE_VIDEO_PAYMENT_INTENT_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd tworzenia płatności' });
  }
});

// POST /api/video/sessions/create - utworzenie nowej sesji wideo (po płatności)
router.post('/sessions/create', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured) {
      return res.status(503).json({ message: 'Wideo-wizyty nie są skonfigurowane. Skontaktuj się z administratorem.' });
    }

    const { providerId, orderId, scheduledAt, price, paymentIntentId } = req.body;
    const clientId = req.user._id;

    // Walidacja
    if (!providerId) {
      return res.status(400).json({ message: 'providerId jest wymagany' });
    }

    const provider = await User.findById(providerId);
    if (!provider || provider.role !== 'provider') {
      return res.status(404).json({ message: 'Wykonawca nie został znaleziony' });
    }

    // Sprawdź czy zlecenie istnieje (jeśli podano)
    if (orderId) {
      const order = await Order.findById(orderId);
      if (!order) {
        return res.status(404).json({ message: 'Zlecenie nie zostało znalezione' });
      }
      if (String(order.client) !== String(clientId)) {
        return res.status(403).json({ message: 'Nie masz uprawnień do tego zlecenia' });
      }
    }

    // Utwórz pokój w Daily.co
    const room = await createRoom({
      privacy: 'private',
      properties: {
        enable_screenshare: true,
        enable_chat: true,
        enable_knocking: false,
        enable_recording: false, // Można włączyć dla PRO
        exp: scheduledAt 
          ? Math.floor(new Date(scheduledAt).getTime() / 1000) + (2 * 60 * 60)
          : Math.floor(Date.now() / 1000) + (24 * 60 * 60)
      }
    });

    // Utwórz tokeny dla uczestników
    const clientToken = await createToken(room.name, {
      userId: String(clientId),
      userName: req.user.name || req.user.email,
      isOwner: true
    });

    const providerToken = await createToken(room.name, {
      userId: String(providerId),
      userName: provider.name || provider.email,
      isOwner: false
    });

    // Zapisz sesję w bazie
    const session = await VideoSession.create({
      client: clientId,
      provider: providerId,
      order: orderId || null,
      dailyRoomId: room.id,
      dailyRoomName: room.name,
      dailyRoomUrl: room.url,
      clientToken,
      providerToken,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      price: price ? Math.round(price * 100) : 0, // Konwersja na grosze
      paid: !!payment,
      paymentId: payment ? payment._id : null,
      status: 'scheduled'
    });

    // Zaktualizuj Payment, aby powiązać z sesją
    if (payment) {
      payment.videoSession = session._id;
      await payment.save();
    }

    // Populate dla odpowiedzi
    await session.populate('client', 'name email avatar');
    await session.populate('provider', 'name email avatar');

    res.json({
      session: {
        _id: session._id,
        dailyRoomName: session.dailyRoomName,
        dailyRoomUrl: session.dailyRoomUrl,
        token: clientToken, // Token dla klienta (twórcy)
        client: session.client,
        provider: session.provider,
        scheduledAt: session.scheduledAt,
        price: session.price / 100, // Konwersja z groszy
        status: session.status
      }
    });
  } catch (error) {
    console.error('CREATE_VIDEO_SESSION_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd tworzenia sesji wideo' });
  }
});

// GET /api/video/sessions/:id/token - pobranie tokena dla sesji
router.get('/sessions/:id/token', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const session = await VideoSession.findById(id);
    if (!session) {
      return res.status(404).json({ message: 'Sesja nie została znaleziona' });
    }

    // Sprawdź czy użytkownik jest uczestnikiem
    const isClient = String(session.client) === String(userId);
    const isProvider = String(session.provider) === String(userId);

    if (!isClient && !isProvider) {
      return res.status(403).json({ message: 'Nie masz uprawnień do tej sesji' });
    }

    // Zwróć odpowiedni token
    const token = isClient ? session.clientToken : session.providerToken;
    const roomUrl = session.dailyRoomUrl;

    res.json({
      token,
      roomUrl,
      roomName: session.dailyRoomName
    });
  } catch (error) {
    console.error('GET_VIDEO_TOKEN_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania tokena' });
  }
});

// PATCH /api/video/sessions/:id/status - aktualizacja statusu sesji
router.patch('/sessions/:id/status', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user._id;

    const validStatuses = ['scheduled', 'active', 'ended', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Nieprawidłowy status' });
    }

    const session = await VideoSession.findById(id);
    if (!session) {
      return res.status(404).json({ message: 'Sesja nie została znaleziona' });
    }

    // Sprawdź uprawnienia
    const isClient = String(session.client) === String(userId);
    const isProvider = String(session.provider) === String(userId);
    if (!isClient && !isProvider) {
      return res.status(403).json({ message: 'Nie masz uprawnień do tej sesji' });
    }

    // Aktualizuj status
    const update = { status };
    
    if (status === 'active' && session.status === 'scheduled') {
      update.startedAt = new Date();
    } else if (status === 'ended' && session.startedAt) {
      update.endedAt = new Date();
      update.duration = Math.floor((new Date() - session.startedAt) / 1000);
    }

    await VideoSession.findByIdAndUpdate(id, update);

    res.json({ message: 'Status zaktualizowany', status });
  } catch (error) {
    console.error('UPDATE_VIDEO_SESSION_STATUS_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktualizacji statusu' });
  }
});

// GET /api/video/sessions/:id/recordings - pobranie nagrań (jeśli dostępne)
router.get('/sessions/:id/recordings', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const session = await VideoSession.findById(id);
    if (!session) {
      return res.status(404).json({ message: 'Sesja nie została znaleziona' });
    }

    // Sprawdź uprawnienia
    const isClient = String(session.client) === String(userId);
    const isProvider = String(session.provider) === String(userId);
    if (!isClient && !isProvider) {
      return res.status(403).json({ message: 'Nie masz uprawnień do tej sesji' });
    }

    // Pobierz nagrania z Daily.co
    const recordings = await getRecordings(session.dailyRoomName);

    res.json({ recordings });
  } catch (error) {
    console.error('GET_VIDEO_RECORDINGS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania nagrań' });
  }
});

// GET /api/video/sessions/by-order/:orderId - pobranie sesji wideo dla zlecenia
router.get('/sessions/by-order/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user._id;

    // Sprawdź czy zlecenie istnieje i użytkownik ma do niego dostęp
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie zostało znalezione' });
    }

    const isClient = String(order.client) === String(userId);
    const isProvider = order.provider && String(order.provider) === String(userId);
    
    if (!isClient && !isProvider) {
      return res.status(403).json({ message: 'Nie masz uprawnień do tego zlecenia' });
    }

    // Znajdź sesję wideo powiązaną z zleceniem
    const session = await VideoSession.findOne({ order: orderId })
      .populate('client', 'name email avatar')
      .populate('provider', 'name email avatar')
      .lean();

    if (!session) {
      return res.json({ session: null });
    }

    // Zwróć token dla obecnego użytkownika
    const isSessionClient = String(session.client._id || session.client) === String(userId);
    const token = isSessionClient ? session.clientToken : session.providerToken;

    res.json({
      session: {
        _id: session._id,
        dailyRoomName: session.dailyRoomName,
        dailyRoomUrl: session.dailyRoomUrl,
        token,
        client: session.client,
        provider: session.provider,
        scheduledAt: session.scheduledAt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        status: session.status,
        price: session.price / 100 // Konwersja z groszy
      }
    });
  } catch (error) {
    console.error('GET_VIDEO_SESSION_BY_ORDER_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania sesji wideo' });
  }
});

module.exports = router;

