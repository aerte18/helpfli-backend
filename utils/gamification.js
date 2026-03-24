const User = require('../models/User');
const Order = require('../models/Order');
const Rating = require('../models/Rating');
const PointTransaction = require('../models/PointTransaction');

/**
 * Gamification System
 * Automatyczne przyznawanie badges i achievements
 * Tier System dla punktów lojalnościowych
 */

// Tier thresholds (punkty wymagane dla każdego tieru)
const TIER_THRESHOLDS = {
  bronze: 0,
  silver: 500,
  gold: 2000,
  platinum: 5000
};

// Tier benefits (korzyści dla każdego tieru)
const TIER_BENEFITS = {
  bronze: {
    name: 'Brązowy',
    discount: 0,
    prioritySupport: false,
    icon: '🥉',
    color: '#CD7F32'
  },
  silver: {
    name: 'Srebrny',
    discount: 5,
    prioritySupport: false,
    icon: '🥈',
    color: '#C0C0C0'
  },
  gold: {
    name: 'Złoty',
    discount: 10,
    prioritySupport: true,
    icon: '🥇',
    color: '#FFD700'
  },
  platinum: {
    name: 'Platynowy',
    discount: 15,
    prioritySupport: true,
    icon: '👑',
    color: '#E5E4E2'
  }
};

/**
 * Oblicz tier na podstawie liczby punktów
 */
function calculateTier(points) {
  if (points >= TIER_THRESHOLDS.platinum) return 'platinum';
  if (points >= TIER_THRESHOLDS.gold) return 'gold';
  if (points >= TIER_THRESHOLDS.silver) return 'silver';
  return 'bronze';
}

/**
 * Aktualizuj tier użytkownika na podstawie punktów
 */
async function updateUserTier(userId) {
  try {
    const PointTransaction = require('../models/PointTransaction');
    const lastTx = await PointTransaction.findOne({ user: userId }).sort({ createdAt: -1 });
    const currentPoints = lastTx?.balanceAfter || 0;
    
    const newTier = calculateTier(currentPoints);
    
    const user = await User.findById(userId);
    if (!user) return null;
    
    const currentTier = user.gamification?.tier || 'bronze';
    
    // Aktualizuj tier tylko jeśli się zmienił
    if (newTier !== currentTier) {
      await User.findByIdAndUpdate(userId, {
        'gamification.tier': newTier
      });
      
      console.log(`✅ Tier updated for user ${userId}: ${currentTier} → ${newTier} (${currentPoints} points)`);
      
      // Przyznaj badge za osiągnięcie nowego tieru
      const tierBadges = {
        silver: 'tier_silver',
        gold: 'tier_gold',
        platinum: 'tier_platinum'
      };
      
      if (tierBadges[newTier]) {
        await awardBadge(userId, tierBadges[newTier]);
      }
      
      return { oldTier: currentTier, newTier, points: currentPoints };
    }
    
    return null;
  } catch (error) {
    console.error('Error updating user tier:', error);
    return null;
  }
}

// Lista wszystkich dostępnych badges
const BADGES = {
  // Podstawowe
  FIRST_LOGIN: 'first_login',
  FIRST_ORDER: 'first_order',
  FIRST_REVIEW: 'first_review',
  
  // Milestone
  ORDERS_10: 'orders_10',
  ORDERS_50: 'orders_50',
  ORDERS_100: 'orders_100',
  REVIEWS_10: 'reviews_10',
  REVIEWS_50: 'reviews_50',
  REVIEWS_100: 'reviews_100',
  
  // Streak
  STREAK_7: 'streak_7',
  STREAK_30: 'streak_30',
  STREAK_100: 'streak_100',
  
  // Punkty
  POINTS_1000: 'points_1000',
  POINTS_5000: 'points_5000',
  POINTS_10000: 'points_10000',
  
  // Provider specific
  PROVIDER_VERIFIED: 'provider_verified',
  PROVIDER_PRO: 'provider_pro',
  PROVIDER_TOP_RATED: 'provider_top_rated', // 4.5+ średnia ocena
  
  // Client specific
  CLIENT_LOYAL: 'client_loyal', // 10+ zleceń
  CLIENT_REVIEWER: 'client_reviewer', // 10+ recenzji
};

// Opisy badges
const BADGE_DESCRIPTIONS = {
  [BADGES.FIRST_LOGIN]: { name: 'Pierwsze kroki', icon: '👋', description: 'Zalogowałeś się po raz pierwszy' },
  [BADGES.FIRST_ORDER]: { name: 'Pierwsze zlecenie', icon: '🎯', description: 'Utworzyłeś pierwsze zlecenie' },
  [BADGES.FIRST_REVIEW]: { name: 'Pierwsza recenzja', icon: '⭐', description: 'Napisałeś pierwszą recenzję' },
  [BADGES.ORDERS_10]: { name: '10 zleceń', icon: '🔥', description: 'Utworzyłeś 10 zleceń' },
  [BADGES.ORDERS_50]: { name: '50 zleceń', icon: '💪', description: 'Utworzyłeś 50 zleceń' },
  [BADGES.ORDERS_100]: { name: '100 zleceń', icon: '🏆', description: 'Utworzyłeś 100 zleceń' },
  [BADGES.REVIEWS_10]: { name: '10 recenzji', icon: '📝', description: 'Napisałeś 10 recenzji' },
  [BADGES.REVIEWS_50]: { name: '50 recenzji', icon: '✍️', description: 'Napisałeś 50 recenzji' },
  [BADGES.REVIEWS_100]: { name: '100 recenzji', icon: '📚', description: 'Napisałeś 100 recenzji' },
  [BADGES.STREAK_7]: { name: '7 dni z rzędu', icon: '🔥', description: 'Logowałeś się 7 dni z rzędu' },
  [BADGES.STREAK_30]: { name: '30 dni z rzędu', icon: '💪', description: 'Logowałeś się 30 dni z rzędu' },
  [BADGES.STREAK_100]: { name: '100 dni z rzędu', icon: '👑', description: 'Logowałeś się 100 dni z rzędu' },
  [BADGES.POINTS_1000]: { name: '1000 punktów', icon: '💎', description: 'Zgromadziłeś 1000 punktów' },
  [BADGES.POINTS_5000]: { name: '5000 punktów', icon: '💍', description: 'Zgromadziłeś 5000 punktów' },
  [BADGES.POINTS_10000]: { name: '10000 punktów', icon: '👑', description: 'Zgromadziłeś 10000 punktów' },
  [BADGES.PROVIDER_VERIFIED]: { name: 'Zweryfikowany', icon: '✅', description: 'Twój profil został zweryfikowany' },
  [BADGES.PROVIDER_PRO]: { name: 'Pakiet PRO', icon: '⭐', description: 'Masz aktywny pakiet PRO' },
  [BADGES.PROVIDER_TOP_RATED]: { name: 'Najlepiej oceniany', icon: '🌟', description: 'Średnia ocena 4.5+' },
  [BADGES.CLIENT_LOYAL]: { name: 'Lojalny klient', icon: '💙', description: 'Utworzyłeś 10+ zleceń' },
  [BADGES.CLIENT_REVIEWER]: { name: 'Recenzent', icon: '📖', description: 'Napisałeś 10+ recenzji' },
};

/**
 * Przyznaj badge użytkownikowi (jeśli jeszcze go nie ma)
 */
async function awardBadge(userId, badgeId) {
  try {
    const user = await User.findById(userId);
    if (!user) return false;
    
    const currentBadges = user.gamification?.badges || [];
    if (currentBadges.includes(badgeId)) {
      return false; // Już ma ten badge
    }
    
    // Dodaj badge
    const newBadges = [...currentBadges, badgeId];
    await User.findByIdAndUpdate(userId, {
      'gamification.badges': newBadges,
      $push: {
        'gamification.achievements': {
          id: badgeId,
          unlockedAt: new Date(),
          progress: 100
        }
      }
    });
    
    console.log(`✅ Badge awarded: ${badgeId} to user ${userId}`);
    return true;
  } catch (error) {
    console.error(`Error awarding badge ${badgeId} to user ${userId}:`, error);
    return false;
  }
}

/**
 * Sprawdź i przyznaj badges po utworzeniu zlecenia
 */
async function checkOrderBadges(userId) {
  try {
    const orderCount = await Order.countDocuments({ client: userId });
    
    if (orderCount === 1) {
      await awardBadge(userId, BADGES.FIRST_ORDER);
    } else if (orderCount === 10) {
      await awardBadge(userId, BADGES.ORDERS_10);
    } else if (orderCount === 50) {
      await awardBadge(userId, BADGES.ORDERS_50);
    } else if (orderCount === 100) {
      await awardBadge(userId, BADGES.ORDERS_100);
    }
    
    // Client specific
    if (orderCount >= 10) {
      await awardBadge(userId, BADGES.CLIENT_LOYAL);
    }
  } catch (error) {
    console.error('Error checking order badges:', error);
  }
}

/**
 * Sprawdź i przyznaj badges po napisaniu recenzji
 */
async function checkReviewBadges(userId) {
  try {
    const reviewCount = await Rating.countDocuments({ from: userId });
    
    if (reviewCount === 1) {
      await awardBadge(userId, BADGES.FIRST_REVIEW);
    } else if (reviewCount === 10) {
      await awardBadge(userId, BADGES.REVIEWS_10);
    } else if (reviewCount === 50) {
      await awardBadge(userId, BADGES.REVIEWS_50);
    } else if (reviewCount === 100) {
      await awardBadge(userId, BADGES.REVIEWS_100);
    }
    
    // Client specific
    if (reviewCount >= 10) {
      await awardBadge(userId, BADGES.CLIENT_REVIEWER);
    }
  } catch (error) {
    console.error('Error checking review badges:', error);
  }
}

/**
 * Sprawdź i przyznaj badges po aktualizacji login streak
 */
async function checkStreakBadges(userId, streak) {
  try {
    if (streak === 7) {
      await awardBadge(userId, BADGES.STREAK_7);
    } else if (streak === 30) {
      await awardBadge(userId, BADGES.STREAK_30);
    } else if (streak === 100) {
      await awardBadge(userId, BADGES.STREAK_100);
    }
  } catch (error) {
    console.error('Error checking streak badges:', error);
  }
}

/**
 * Sprawdź i przyznaj badges po aktualizacji punktów
 */
async function checkPointsBadges(userId) {
  try {
    const lastTx = await PointTransaction.findOne({ user: userId }).sort({ createdAt: -1 });
    const currentPoints = lastTx?.balanceAfter || 0;
    
    if (currentPoints >= 10000) {
      await awardBadge(userId, BADGES.POINTS_10000);
    } else if (currentPoints >= 5000) {
      await awardBadge(userId, BADGES.POINTS_5000);
    } else if (currentPoints >= 1000) {
      await awardBadge(userId, BADGES.POINTS_1000);
    }
    
    // Aktualizuj tier na podstawie punktów
    await updateUserTier(userId);
  } catch (error) {
    console.error('Error checking points badges:', error);
  }
}

/**
 * Sprawdź i przyznaj badges dla providera
 */
async function checkProviderBadges(userId) {
  try {
    const user = await User.findById(userId);
    if (!user || user.role !== 'provider') return;
    
    // Verified badge
    if (user.verification?.status === 'verified' || (Array.isArray(user.badges) && user.badges.includes('verified'))) {
      await awardBadge(userId, BADGES.PROVIDER_VERIFIED);
    }
    
    // PRO badge
    const UserSubscription = require('../models/UserSubscription');
    const subscription = await UserSubscription.findOne({
      user: userId,
      validUntil: { $gt: new Date() }
    });
    if (subscription?.planKey === 'PROV_PRO') {
      await awardBadge(userId, BADGES.PROVIDER_PRO);
    }
    
    // Top rated badge
    const Rating = require('../models/Rating');
    const ratings = await Rating.find({ to: userId });
    if (ratings.length > 0) {
      const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
      if (avgRating >= 4.5) {
        await awardBadge(userId, BADGES.PROVIDER_TOP_RATED);
      }
    }
  } catch (error) {
    console.error('Error checking provider badges:', error);
  }
}

/**
 * Sprawdź wszystkie badges użytkownika (wywoływane okresowo)
 */
async function checkAllBadges(userId) {
  try {
    await checkOrderBadges(userId);
    await checkReviewBadges(userId);
    await checkPointsBadges(userId);
    await checkProviderBadges(userId);
    
    const user = await User.findById(userId);
    if (user?.gamification?.loginStreak) {
      await checkStreakBadges(userId, user.gamification.loginStreak);
    }
  } catch (error) {
    console.error('Error checking all badges:', error);
  }
}

// Dodaj tier badges do BADGES
BADGES.TIER_SILVER = 'tier_silver';
BADGES.TIER_GOLD = 'tier_gold';
BADGES.TIER_PLATINUM = 'tier_platinum';

// Dodaj tier badge descriptions
BADGE_DESCRIPTIONS[BADGES.TIER_SILVER] = { 
  name: 'Srebrny Tier', 
  icon: '🥈', 
  description: 'Osiągnąłeś 500 punktów - otrzymujesz 5% zniżki' 
};
BADGE_DESCRIPTIONS[BADGES.TIER_GOLD] = { 
  name: 'Złoty Tier', 
  icon: '🥇', 
  description: 'Osiągnąłeś 2000 punktów - otrzymujesz 10% zniżki + priority support' 
};
BADGE_DESCRIPTIONS[BADGES.TIER_PLATINUM] = { 
  name: 'Platynowy Tier', 
  icon: '👑', 
  description: 'Osiągnąłeś 5000 punktów - otrzymujesz 15% zniżki + priority support' 
};

module.exports = {
  BADGES,
  BADGE_DESCRIPTIONS,
  TIER_THRESHOLDS,
  TIER_BENEFITS,
  calculateTier,
  updateUserTier,
  awardBadge,
  checkOrderBadges,
  checkReviewBadges,
  checkStreakBadges,
  checkPointsBadges,
  checkProviderBadges,
  checkAllBadges
};

