const express = require('express');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/authMiddleware');
const router = express.Router();

// GET /api/providers - lista wszystkich usługodawców z opcjonalnym wyszukiwaniem
router.get('/', async (req, res) => {
  try {
    const { search, q, service, level, rating, available } = req.query;
    const { resolveServicesForSearchFilter } = require('../utils/resolveServiceSearch');
    
    // Buduj query
    let query = { role: 'provider' };
    
    const searchTerm = (search && search.trim()) || (q && String(q).trim()) || '';
    if (searchTerm) {
      const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { name: searchRegex },
        { email: searchRegex },
        { 'services.name': searchRegex }
      ];
    }

    if (service && String(service).trim()) {
      const { ids: serviceIds, hadServiceTokens } = await resolveServicesForSearchFilter(service);
      if (hadServiceTokens) {
        if (serviceIds.length > 0) {
          query.services = { $in: serviceIds };
        } else {
          return res.json({ items: [] });
        }
      }
    }
    
    if (level && level !== 'all') {
      query.providerLevel = level;
    }
    
    if (rating && !isNaN(rating)) {
      // TODO: Dodać filtrowanie po ratingu gdy będzie dostępny
    }
    
    if (available === 'true') {
      query['provider_status.isOnline'] = true;
    }
    
    const providers = await User.find(query)
      .select('name email avatar providerLevel provider_status locationCoords services')
      .lean();
    
    res.json({ items: providers });
  } catch (err) {
    console.error('GET_PROVIDERS_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania listy usługodawców' });
  }
});

// Prosty in-memory cache dla /match-top (TTL: 60 sekund)
const matchTopCache = {
  data: null,
  timestamp: null,
  ttl: 60 * 1000, // 60 sekund
  key: null
};

// GET /api/providers/match-top - AI matching TOP 3 wykonawców
// query: serviceCode, lat, lng, urgency, limit=3
router.get('/match-top', async (req, res) => {
  try {
    const { serviceCode, lat, lng, urgency = 'normal', limit = 3 } = req.query;
    
    if (!serviceCode) {
      return res.status(400).json({ message: 'serviceCode jest wymagany' });
    }

    const latNum = lat ? parseFloat(lat) : null;
    const lngNum = lng ? parseFloat(lng) : null;

    // Tworzymy klucz cache na podstawie parametrów
    const cacheKey = `${serviceCode}_${latNum || 'null'}_${lngNum || 'null'}_${urgency}_${limit}`;
    const now = Date.now();

    // Sprawdź cache
    if (matchTopCache.data && matchTopCache.key === cacheKey && matchTopCache.timestamp && (now - matchTopCache.timestamp) < matchTopCache.ttl) {
      return res.json(matchTopCache.data);
    }

    const providers = await recommendProviders(
      serviceCode,
      latNum,
      lngNum,
      parseInt(limit) || 3,
      urgency
    );

    const result = {
      providers: providers.slice(0, parseInt(limit) || 3),
      count: providers.length,
      serviceCode,
      location: latNum && lngNum ? { lat: latNum, lng: lngNum } : null,
      cached: false
    };

    // Zapisz do cache
    matchTopCache.data = result;
    matchTopCache.timestamp = now;
    matchTopCache.key = cacheKey;

    res.json(result);
  } catch (error) {
    console.error('MATCH_TOP_ERROR:', error);
    res.status(500).json({ message: 'Błąd dopasowywania wykonawców' });
  }
});

// PATCH /api/providers/me/status - aktualizacja statusu usługodawcy
router.patch('/me/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const userId = req.user._id;
    
    // Sprawdź czy użytkownik jest usługodawcą
    const user = await User.findById(userId);
    if (!user || user.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla usługodawców' });
    }
    
    // Walidacja statusu - tylko online/offline
    const validStatuses = ['online', 'offline'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Nieprawidłowy status. Dozwolone: online, offline' });
    }
    
    // Aktualizuj status
    await User.findByIdAndUpdate(userId, {
      'provider_status.isOnline': status === 'online',
      'provider_status.lastSeenAt': new Date()
    });
    
    res.json({ message: 'Status zaktualizowany', status });
  } catch (err) {
    console.error('UPDATE_PROVIDER_STATUS_ERROR:', err);
    res.status(500).json({ message: 'Błąd aktualizacji statusu' });
  }
});

// GET /api/providers/me/status - pobranie statusu usługodawcy
router.get('/me/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const user = await User.findById(userId).select('provider_status role');
    if (!user || user.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla usługodawców' });
    }
    
    res.json({ 
      status: user.provider_status?.isOnline ? 'online' : 'offline',
      lastSeenAt: user.provider_status?.lastSeenAt
    });
  } catch (err) {
    console.error('GET_PROVIDER_STATUS_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania statusu' });
  }
});

// GET /api/providers/stats - statystyki usługodawcy
router.get('/me/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Sprawdź czy użytkownik jest usługodawcą
    const user = await User.findById(userId);
    if (!user || user.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla usługodawców' });
    }
    
    // TODO: Pobierz rzeczywiste statystyki z bazy danych
    // Na razie zwracamy mockowe dane
    const stats = {
      newOrders24h: 8,
      proposalsSent7d: 12,
      acceptanceRate: 46,
      totalEarnings: 2400,
      completedOrders: 15
    };
    
    res.json(stats);
  } catch (err) {
    console.error('GET_PROVIDER_STATS_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

// GET /api/providers/me/order-stats - szczegółowe statystyki zleceń dla providera
router.get('/me/order-stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Sprawdź czy użytkownik jest usługodawcą
    const user = await User.findById(userId);
    if (!user || user.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla usługodawców' });
    }
    
    const Order = require('../models/Order');
    
    // Wszystkie zlecenia przypisane do providera
    const totalOrders = await Order.countDocuments({ provider: userId });
    
    // W trakcie realizacji
    const inProgress = await Order.countDocuments({ 
      provider: userId, 
      status: 'in_progress' 
    });
    
    // Zakończone ale jeszcze nie rozliczone (completed ale nie released i nie paid)
    const completedNotReleased = await Order.countDocuments({ 
      provider: userId, 
      status: 'completed',
      $or: [
        { 'payment.status': { $ne: 'paid' } },
        { 'payment.status': { $exists: false } },
        { 'payment.status': null },
        { 'payment': { $exists: false } }
      ]
    });
    
    // Rozliczone (released lub payment.status = 'paid')
    const released = await Order.countDocuments({ 
      provider: userId, 
      $or: [
        { status: 'released' },
        { 'payment.status': 'paid' }
      ]
    });
    
    // Oczekujące (accepted, funded)
    const pending = await Order.countDocuments({ 
      provider: userId, 
      status: { $in: ['accepted', 'funded', 'matched'] } 
    });
    
    // Anulowane
    const cancelled = await Order.countDocuments({ 
      provider: userId, 
      status: 'cancelled' 
    });
    
    res.json({
      success: true,
      stats: {
        total: totalOrders,
        inProgress: inProgress,
        completedNotReleased: completedNotReleased,
        released: released,
        pending: pending,
        cancelled: cancelled
      }
    });
  } catch (err) {
    console.error('GET_PROVIDER_ORDER_STATS_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania statystyk zleceń', error: err.message });
  }
});

// --- MINI PROFILE ---
// GET /api/providers/:id/mini – publiczny (goście mogą widzieć statystyki i badge'e)
router.get('/:id/mini', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).populate('company', 'name logo').lean();
    if (!user) return res.status(404).json({ message: 'Wykonawca nie istnieje' });

    // Ratings aggregate
    const Rating = require('../models/Rating');
    const ratingsAgg = await Rating.aggregate([
      { $match: { to: user._id } },
      { $group: { _id: '$to', avg: { $avg: '$rating' }, cnt: { $sum: 1 } } }
    ]);
    const ratingAvg = Number(ratingsAgg?.[0]?.avg?.toFixed(2)) || 0;
    const ratingCount = ratingsAgg?.[0]?.cnt || 0;

    const Order = require('../models/Order');
    const completedOrders = await Order.countDocuments({ provider: user._id, status: { $in: ['completed','done','closed'] } });

    const accepted = await Order.countDocuments({ provider: user._id, status: { $in: ['accepted','in_progress','completed','done','closed'] } });
    
    // Oblicz prawdziwą liczbę zaproszeń: unikalne zlecenia gdzie provider był zaproszony LUB złożył ofertę
    const Offer = require('../models/Offer');
    
    // Zlecenia gdzie provider był zaproszony
    const invitedOrderIds = await Order.distinct('_id', { 
      invitedProviders: user._id,
      status: { $in: ['open', 'accepted', 'in_progress', 'completed', 'done', 'closed', 'matched', 'paid', 'funded'] }
    });
    
    // Zlecenia gdzie provider złożył ofertę
    const offerOrderIds = await Offer.distinct('orderId', { providerId: user._id });
    
    // Połącz i policz unikalne zlecenia
    const allOrderIds = [...new Set([...invitedOrderIds.map(id => String(id)), ...offerOrderIds.map(id => String(id))])];
    const received = Math.max(allOrderIds.length, accepted, 1); // minimum 1 aby uniknąć dzielenia przez 0
    
    const acceptanceRate = received > 0 ? Math.min(100, Math.round((accepted / received) * 100)) : 0;

    const onTimeOrders = await Order.countDocuments({ provider: user._id, status: { $in: ['completed','done','closed'] }, deliveredOnTime: true }).catch(() => 0);
    const onTimeRate = completedOrders ? Math.round((onTimeOrders / completedOrders) * 100) : 0;

    const responseTimeMin = user?.meta?.responseTimeMin ?? 30;
    const level = user?.providerLevel || 'standard';
    const availability = user?.provider_status?.isOnline ? 'online' : 'offline';
    const badges = user?.badges || [];

    // Pobierz subscription plan
    const UserSubscription = require('../models/UserSubscription');
    const subscription = await UserSubscription.findOne({
      user: user._id,
      status: 'active'
    }).lean();
    const planKey = subscription?.planKey || null;

    // Pobierz boosty
    const Boost = require('../models/Boost');
    const boosts = await Boost.find({
      provider: user._id,
      $or: [
        { endsAt: { $gt: new Date() } },
        { endsAt: null }
      ]
    }).select('code endsAt').lean();

    res.json({
      _id: String(user._id),
      name: user.name || user.email || 'Wykonawca',
      avatar: user.avatar || null,
      level, availability, badges,
      ratingAvg, ratingCount,
      completedOrders,
      acceptanceRate,
      onTimeRate,
      responseTimeMin,
      // B2B i subscription data
      company: user.company ? {
        _id: user.company._id,
        name: user.company.name,
        logo: user.company.logo
      } : null,
      subscriptionPlan: planKey,
      planKey: planKey,
      boosts: boosts.map(b => ({
        code: b.code,
        endsAt: b.endsAt
      }))
    });
  } catch (e) {
    console.error('providers mini error:', e);
    res.status(500).json({ message: 'Błąd odczytu profilu' });
  }
});

// Nested router dla provider billing
try {
  const providerBillingRoutes = require('./provider_billing');
  router.use('/billing', providerBillingRoutes);
} catch (e) {
  console.warn('⚠️ Provider billing routes not loaded:', e.message);
}

module.exports = router;
