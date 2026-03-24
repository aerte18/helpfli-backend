?const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const Offer = require('../models/Offer');
const Order = require('../models/Order');
const UserSubscription = require('../models/UserSubscription');

// GET /api/provider-stats - pobierz statystyki providera
router.get('/', authMiddleware, async (req, res) => {
  try {
    const provider = await User.findById(req.user._id);
    
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    
    // Sprawdź pakiet providera
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    const packageType = subscription?.planKey || 'PROV_FREE';
    const isPro = packageType === 'PROV_PRO';
    const isStandard = packageType === 'PROV_STD';
    
    // Podstawowe statystyki (dla wszystkich pakietów)
    const basicStats = {
      profileViews: provider.profileViews || 0,
      monthlyOffersUsed: provider.monthlyOffersUsed || 0,
      monthlyOffersLimit: provider.monthlyOffersLimit || 10,
      wonOffers: provider.wonOffers || 0,
      successRate: provider.successRate || 0,
      averageOfferPrice: provider.averageOfferPrice || 0
    };
    
    // Statystyki zaawansowane (tylko dla PRO)
    let advancedStats = null;
    if (isPro) {
      // Pobierz wszystkie oferty providera
      const offers = await Offer.find({ providerId: req.user._id });
      const totalOffers = offers.length;
      const acceptedOffers = offers.filter(offer => offer.status === 'accepted').length;
      const totalRevenue = offers
        .filter(offer => offer.status === 'accepted')
        .reduce((sum, offer) => sum + (offer.amount || 0), 0);
      
      // Pobierz zlecenia w regionie (dla porównania z konkurencją)
      // Tymczasowo wyłączymy geolokalizację do czasu naprawy indeksów
      const regionOrders = await Order.find({}).limit(100);
      
      advancedStats = {
        totalOffers,
        acceptedOffers,
        totalRevenue,
        averageRevenuePerOffer: acceptedOffers > 0 ? Math.round(totalRevenue / acceptedOffers) : 0,
        competitionInRegion: regionOrders.length,
        marketShare: regionOrders.length > 0 ? Math.round((acceptedOffers / regionOrders.length) * 100) : 0,
        topServices: await getTopServicesInRegion(provider.locationCoords),
        monthlyTrend: await getMonthlyTrend(req.user._id)
      };
    }
    
    res.json({
      package: packageType,
      basic: basicStats,
      advanced: advancedStats,
      features: {
        hasAdvancedStats: isPro,
        hasFavoriteClients: isStandard || isPro,
        hasAiChat: isStandard || isPro,
        hasMonthlyReport: isPro,
        hasHelpfliGuarantee: isPro,
        isTopProvider: isPro
      }
    });
  } catch (error) {
    console.error('❌ Błąd pobierania statystyk:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

// GET /api/provider-stats/free-replies-left – licznik darmowych wycen
router.get('/free-replies-left', authMiddleware, async (req, res) => {
  try {
    const provider = await User.findById(req.user._id).lean();
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    // plan i limit
    const UserSubscription = require('../models/UserSubscription');
    const subs = await UserSubscription.findOne({ user: req.user._id, validUntil: { $gt: new Date() }}).lean();
    const key = subs?.planKey || 'PROVIDER_FREE';
    const limits = { PROVIDER_FREE: 10, PROVIDER_STANDARD: 50, PROVIDER_PRO: Infinity };
    const limit = limits[key] ?? 10;
    if (limit === Infinity) return res.json({ freeRepliesLeft: Infinity });
    // policz oferty w tym miesiącu
    const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
    const Order = require('../models/Order');
    const used = await Order.aggregate([
      { $match: { 'proposals.providerId': provider._id, createdAt: { $gte: start } } },
      { $project: { proposals: 1 } },
      { $unwind: '$proposals' },
      { $match: { 'proposals.providerId': provider._id } },
      { $count: 'count' }
    ]).then(r => r[0]?.count || 0).catch(()=>0);
    res.json({ freeRepliesLeft: Math.max(0, limit - used) });
  } catch (e) {
    res.status(500).json({ message: 'Błąd pobierania limitu' });
  }
});

// Funkcja pomocnicza do pobierania top usług w regionie
async function getTopServicesInRegion(coords) {
  try {
    // Tymczasowo wyłączymy geolokalizację do czasu naprawy indeksów
    const regionOrders = await Order.find({}).limit(100);
    
    const serviceCounts = {};
    regionOrders.forEach(order => {
      const service = order.service || 'inne';
      serviceCounts[service] = (serviceCounts[service] || 0) + 1;
    });
    
    return Object.entries(serviceCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([service, count]) => ({ service, count }));
  } catch (error) {
    console.error('❌ Błąd pobierania top usług:', error);
    return [];
  }
}

// Funkcja pomocnicza do pobierania trendu miesięcznego
async function getMonthlyTrend(providerId) {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const offers = await Offer.find({
      providerId,
      createdAt: { $gte: sixMonthsAgo }
    });
    
    const monthlyData = {};
    offers.forEach(offer => {
      const month = offer.createdAt.toISOString().substring(0, 7); // YYYY-MM
      if (!monthlyData[month]) {
        monthlyData[month] = { offers: 0, revenue: 0 };
      }
      monthlyData[month].offers += 1;
      if (offer.status === 'accepted') {
        monthlyData[month].revenue += offer.amount || 0;
      }
    });
    
    return Object.entries(monthlyData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));
  } catch (error) {
    console.error('❌ Błąd pobierania trendu miesięcznego:', error);
    return [];
  }
}

// GET /api/provider-stats/pdf - generuj raport PDF (tylko PRO)
router.get('/pdf', authMiddleware, async (req, res) => {
  try {
    const provider = await User.findById(req.user._id);
    
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    
    // Sprawdź pakiet providera
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    const packageType = subscription?.planKey || 'PROV_FREE';
    if (packageType !== 'PROV_PRO') {
      return res.status(403).json({ message: 'Generowanie PDF dostępne tylko w pakiecie PRO' });
    }
    
    // Pobierz dane do raportu
    const offers = await Offer.find({ providerId: req.user._id });
    const acceptedOffers = offers.filter(offer => offer.status === 'accepted');
    const totalRevenue = acceptedOffers.reduce((sum, offer) => sum + (offer.amount || 0), 0);
    
    // Generuj prosty raport HTML
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Raport Providera - ${provider.name}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .header { text-align: center; margin-bottom: 30px; }
          .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
          .stat-card { border: 1px solid #ddd; padding: 20px; border-radius: 8px; }
          .stat-value { font-size: 24px; font-weight: bold; color: #7c3aed; }
          .stat-label { color: #666; margin-top: 5px; }
          .footer { margin-top: 40px; text-align: center; color: #666; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Raport Providera</h1>
          <h2>${provider.name}</h2>
          <p>Wygenerowano: ${new Date().toLocaleDateString('pl-PL')}</p>
        </div>
        
        <div class="stats">
          <div class="stat-card">
            <div class="stat-value">${offers.length}</div>
            <div class="stat-label">Łączne oferty</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${acceptedOffers.length}</div>
            <div class="stat-label">Zaakceptowane oferty</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${totalRevenue} zł</div>
            <div class="stat-label">Łączny przychód</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${acceptedOffers.length > 0 ? Math.round(totalRevenue / acceptedOffers.length) : 0} zł</div>
            <div class="stat-label">Średnia na ofertę</div>
          </div>
        </div>
        
        <div class="footer">
          <p>Raport wygenerowany przez Helpfli</p>
        </div>
      </body>
      </html>
    `;
    
    // TODO: Implementować rzeczywiste generowanie PDF z puppeteer
    // Na razie zwracamy HTML
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="raport_providera_${new Date().toISOString().split('T')[0]}.html"`);
    res.send(html);
    
  } catch (error) {
    console.error('❌ Błąd generowania PDF:', error);
    res.status(500).json({ message: 'Błąd generowania raportu PDF' });
  }
});

module.exports = router;
