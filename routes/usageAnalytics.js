const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const UsageAnalytics = require('../models/UsageAnalytics');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const User = require('../models/User');

// GET /api/usage/me - Pobierz swoje statystyki użycia
router.get('/me', auth, async (req, res) => {
  try {
    const { month } = req.query || {}; // Format: 'YYYY-MM', domyślnie obecny miesiąc
    
    const now = new Date();
    const monthKey = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    // Pobierz subskrypcję użytkownika
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    const plan = subscription 
      ? await SubscriptionPlan.findOne({ key: subscription.planKey })
      : await SubscriptionPlan.findOne({ key: req.user.role === 'provider' ? 'PROV_FREE' : 'CLIENT_FREE' });
    
    // Pobierz statystyki użycia
    const usage = await UsageAnalytics.findOne({ 
      user: req.user._id, 
      monthKey 
    });
    
    // Jeśli brak statystyk - utwórz pusty rekord
    // Określ limity na podstawie planu
    let aiQueriesLimit = 0;
    let providerResponsesLimit = 10;
    
    if (plan) {
      // Dla klientów - AI queries limit
      if (req.user.role === 'client') {
        if (subscription?.planKey === 'CLIENT_FREE') {
          aiQueriesLimit = 50;
        } else {
          aiQueriesLimit = Infinity; // STANDARD i PRO mają nielimitowane
        }
      }
      
      // Dla providerów - responses limit i AI Chat limit
      if (req.user.role === 'provider') {
        providerResponsesLimit = plan.providerOffersLimit || 10;
        // AI Chat: 20 dla FREE, nielimitowane dla STD/PRO
        if (subscription?.planKey === 'PROV_FREE') {
          // Limit 20 zapytań dla FREE
        } else {
          // Nielimitowane dla STD/PRO
        }
      }
    }
    
    // Dla providerów - określ limit AI Chat
    let providerAiChatQueriesLimit = Infinity;
    if (req.user.role === 'provider') {
      if (!subscription || subscription.planKey === 'PROV_FREE') {
        providerAiChatQueriesLimit = 20; // Limit 20 dla FREE
      } else {
        providerAiChatQueriesLimit = Infinity; // Nielimitowane dla STD/PRO
      }
    }
    
    const stats = usage || {
      aiQueries: 0,
      aiQueriesLimit: aiQueriesLimit,
      aiQueriesPaid: 0,
      providerResponses: 0,
      providerResponsesLimit: providerResponsesLimit,
      providerResponsesPaid: 0,
      providerAiChatQueries: 0,
      providerAiChatQueriesLimit: providerAiChatQueriesLimit,
      providerAiChatQueriesPaid: 0,
      fastTrackUsed: 0,
      fastTrackFree: subscription?.freeExpressLeft || 0,
      fastTrackPaid: 0,
      ordersCreated: 0,
      revenueGenerated: 0,
      platformFeePaid: 0
    };
    
    // Jeśli istnieją dane użycia, użyj ich
    if (usage) {
      stats.aiQueries = usage.aiQueries || 0;
      stats.aiQueriesPaid = usage.aiQueriesPaid || 0;
      stats.providerResponses = usage.providerResponses || 0;
      stats.providerResponsesPaid = usage.providerResponsesPaid || 0;
      stats.providerAiChatQueries = usage.providerAiChatQueries || 0;
      stats.providerAiChatQueriesLimit = usage.providerAiChatQueriesLimit || providerAiChatQueriesLimit;
      stats.providerAiChatQueriesPaid = usage.providerAiChatQueriesPaid || 0;
      stats.fastTrackUsed = usage.fastTrackUsed || 0;
      stats.fastTrackFree = subscription?.freeExpressLeft || 0;
      stats.fastTrackPaid = usage.fastTrackPaid || 0;
      stats.ordersCreated = usage.ordersCreated || 0;
      stats.revenueGenerated = usage.revenueGenerated || 0;
      stats.platformFeePaid = usage.platformFeePaid || 0;
    }
    
    // Oblicz procent użycia
    const aiUsagePercent = stats.aiQueriesLimit > 0 
      ? Math.min(100, (stats.aiQueries / stats.aiQueriesLimit) * 100)
      : 0;
    
    const responsesUsagePercent = stats.providerResponsesLimit > 0 && stats.providerResponsesLimit !== Infinity
      ? Math.min(100, (stats.providerResponses / stats.providerResponsesLimit) * 100)
      : 0;
    
    res.json({
      month: monthKey,
      plan: {
        key: subscription?.planKey || (req.user.role === 'provider' ? 'PROV_FREE' : 'CLIENT_FREE'),
        name: plan?.name || 'FREE'
      },
      usage: {
        aiConcierge: {
          used: stats.aiQueries,
          limit: stats.aiQueriesLimit === Infinity ? 'Nielimitowane' : stats.aiQueriesLimit,
          paid: stats.aiQueriesPaid,
          usagePercent: aiUsagePercent,
          remaining: stats.aiQueriesLimit === Infinity ? 'Nielimitowane' : Math.max(0, stats.aiQueriesLimit - stats.aiQueries)
        },
        providerResponses: {
          used: stats.providerResponses,
          limit: stats.providerResponsesLimit === Infinity ? 'Nielimitowane' : stats.providerResponsesLimit,
          paid: stats.providerResponsesPaid,
          usagePercent: responsesUsagePercent,
          remaining: stats.providerResponsesLimit === Infinity ? 'Nielimitowane' : Math.max(0, stats.providerResponsesLimit - stats.providerResponses)
        },
        providerAiChatQueries: req.user.role === 'provider' ? {
          used: stats.providerAiChatQueries || 0,
          limit: stats.providerAiChatQueriesLimit === Infinity ? 'Nielimitowane' : stats.providerAiChatQueriesLimit,
          remaining: stats.providerAiChatQueriesLimit === Infinity ? 'Nielimitowane' : Math.max(0, stats.providerAiChatQueriesLimit - (stats.providerAiChatQueries || 0))
        } : undefined,
        fastTrack: {
          used: stats.fastTrackUsed,
          free: stats.fastTrackFree,
          paid: stats.fastTrackPaid,
          remaining: Math.max(0, stats.fastTrackFree - stats.fastTrackUsed)
        },
        ordersCreated: stats.ordersCreated,
        revenueGenerated: req.user.role === 'provider' ? stats.revenueGenerated / 100 : 0, // w zł
        platformFeePaid: stats.platformFeePaid / 100 // w zł
      },
      recommendations: generateRecommendations(stats, plan, subscription)
    });
  } catch (error) {
    console.error('Error getting usage analytics:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk użycia' });
  }
});

function generateRecommendations(stats, plan, subscription) {
  const recommendations = [];
  
  // AI Concierge recommendations
  if (stats.aiQueriesLimit !== Infinity && stats.aiQueries >= stats.aiQueriesLimit * 0.8) {
    recommendations.push({
      type: 'upgrade',
      title: 'Zbliżasz się do limitu AI Concierge',
      message: `Użyłeś ${stats.aiQueries}/${stats.aiQueriesLimit} zapytań. Upgrade do STANDARD za nielimitowany dostęp.`,
      action: 'upgrade',
      planKey: 'CLIENT_STD',
      savings: `Oszczędź ${stats.aiQueriesPaid * 0.5} zł na pay-per-use`
    });
  }
  
  // Provider responses recommendations
  if (stats.providerResponsesLimit !== Infinity && stats.providerResponses >= stats.providerResponsesLimit * 0.8) {
    recommendations.push({
      type: 'upgrade',
      title: 'Zbliżasz się do limitu odpowiedzi',
      message: `Użyłeś ${stats.providerResponses}/${stats.providerResponsesLimit} odpowiedzi. Upgrade do PRO za nielimitowany dostęp.`,
      action: 'upgrade',
      planKey: 'PROV_PRO',
      savings: `Oszczędź ${stats.providerResponsesPaid * 2} zł na pay-per-use`
    });
  }
  
  // Fast-Track recommendations
  if (stats.fastTrackFree > 0 && stats.fastTrackUsed >= stats.fastTrackFree) {
    recommendations.push({
      type: 'info',
      title: 'Wyczerpałeś darmowe Fast-Track',
      message: 'Możesz kupić dodatkowe Fast-Track za 10 zł lub upgrade do PRO za nielimitowany dostęp.',
      action: 'upgrade',
      planKey: 'CLIENT_PRO'
    });
  }
  
  return recommendations;
}

// GET /api/usage/history - Historia użycia (ostatnie 6 miesięcy)
router.get('/history', auth, async (req, res) => {
  try {
    const months = [];
    const now = new Date();
    
    for (let i = 0; i < 6; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      months.push(monthKey);
    }
    
    const usageHistory = await UsageAnalytics.find({
      user: req.user._id,
      monthKey: { $in: months }
    }).sort({ monthKey: -1 });
    
    res.json({
      history: usageHistory.map(u => ({
        month: u.monthKey,
        aiQueries: u.aiQueries,
        providerResponses: u.providerResponses,
        fastTrackUsed: u.fastTrackUsed,
        ordersCreated: u.ordersCreated,
        revenueGenerated: u.revenueGenerated / 100
      }))
    });
  } catch (error) {
    console.error('Error getting usage history:', error);
    res.status(500).json({ message: 'Błąd pobierania historii użycia' });
  }
});

module.exports = router;

