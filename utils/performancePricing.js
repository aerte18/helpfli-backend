const Order = require('../models/Order');
const UserSubscription = require('../models/UserSubscription');

/**
 * Oblicza performance-based discount dla providera na podstawie osiągnięć w poprzednim miesiącu
 * @param {String} providerId - ID providera
 * @param {Date} referenceDate - Data referencyjna (domyślnie obecna data)
 * @returns {Object} - { discountPercent: number, ordersCompleted: number, tier: string }
 */
async function calculatePerformanceDiscount(providerId, referenceDate = new Date()) {
  try {
    // Oblicz poprzedni miesiąc (miesiąc który właśnie się zakończył)
    const lastMonth = new Date(referenceDate);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(1);
    lastMonth.setHours(0, 0, 0, 0);
    
    const lastMonthEnd = new Date(lastMonth);
    lastMonthEnd.setMonth(lastMonthEnd.getMonth() + 1);
    lastMonthEnd.setDate(0); // Ostatni dzień poprzedniego miesiąca
    lastMonthEnd.setHours(23, 59, 59, 999);
    
    // Policz zakończone zlecenia w poprzednim miesiącu
    const ordersCompleted = await Order.countDocuments({
      provider: providerId,
      status: { $in: ['completed', 'closed'] },
      createdAt: { $gte: lastMonth, $lte: lastMonthEnd }
    });
    
    // Oblicz discount na podstawie osiągnięć
    // 10+ zleceń = 20% zniżki
    // 20+ zleceń = 30% zniżki
    // 30+ zleceń = 40% zniżki
    let discountPercent = 0;
    let tier = 'none';
    
    if (ordersCompleted >= 30) {
      discountPercent = 40;
      tier = 'excellent';
    } else if (ordersCompleted >= 20) {
      discountPercent = 30;
      tier = 'great';
    } else if (ordersCompleted >= 10) {
      discountPercent = 20;
      tier = 'good';
    }
    
    return {
      discountPercent,
      ordersCompleted,
      tier,
      period: {
        start: lastMonth,
        end: lastMonthEnd
      }
    };
  } catch (error) {
    console.error('Error calculating performance discount:', error);
    return {
      discountPercent: 0,
      ordersCompleted: 0,
      tier: 'none',
      period: null
    };
  }
}

/**
 * Sprawdza czy provider kwalifikuje się do performance discount w obecnym miesiącu
 * @param {String} providerId - ID providera
 * @returns {Object} - Performance discount info
 */
async function getCurrentPerformanceDiscount(providerId) {
  return await calculatePerformanceDiscount(providerId);
}

/**
 * Zastosuj performance discount do ceny subskrypcji
 * @param {Number} basePrice - Bazowa cena (w groszach)
 * @param {Number} performanceDiscountPercent - Procent zniżki z performance
 * @returns {Number} - Cena po zniżce (w groszach)
 */
function applyPerformanceDiscount(basePrice, performanceDiscountPercent) {
  if (!performanceDiscountPercent || performanceDiscountPercent <= 0) {
    return basePrice;
  }
  
  const discountAmount = Math.round((basePrice * performanceDiscountPercent) / 100);
  return Math.max(0, basePrice - discountAmount);
}

module.exports = {
  calculatePerformanceDiscount,
  getCurrentPerformanceDiscount,
  applyPerformanceDiscount
};







