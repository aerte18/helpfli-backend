const Company = require('../models/Company');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');

/**
 * Sprawdza czy użytkownik może użyć zasobu z puli firmowej
 * @param {String} userId - ID użytkownika
 * @param {String} resourceType - 'aiQueries', 'fastTrack', 'providerResponses'
 * @param {Number} amount - Ilość do wykorzystania (domyślnie 1)
 * @returns {Object} { allowed: Boolean, reason: String, remaining: Number }
 */
async function canUseCompanyResource(userId, resourceType, amount = 1) {
  try {
    const user = await User.findById(userId).populate('company');
    
    if (!user || !user.company) {
      return { allowed: false, reason: 'Użytkownik nie należy do firmy' };
    }
    
    const company = await Company.findById(user.company._id);
    if (!company || !company.resourcePool) {
      return { allowed: false, reason: 'Firma nie ma włączonego resource pooling' };
    }
    
    const pool = company.resourcePool;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    // Sprawdź czy trzeba zresetować limity (nowy miesiąc)
    const resetDate = pool[`${resourceType}ResetDate`];
    if (!resetDate || resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
      // Reset limitów na nowy miesiąc
      pool[`${resourceType}Used`] = 0;
      pool[`${resourceType}ResetDate`] = new Date(now.getFullYear(), now.getMonth(), 1);
      await company.save();
    }
    
    const limit = pool[`${resourceType}Limit`] || 0;
    const used = pool[`${resourceType}Used`] || 0;
    const remaining = Math.max(0, limit - used);
    
    // Jeśli limit = 0, oznacza brak limitu (nielimitowane)
    if (limit === 0) {
      return { allowed: true, reason: 'Brak limitu', remaining: Infinity };
    }
    
    if (used + amount > limit) {
      return { 
        allowed: false, 
        reason: `Przekroczono limit ${resourceType} (${used}/${limit})`,
        remaining: remaining
      };
    }
    
    return { 
      allowed: true, 
      reason: 'OK', 
      remaining: remaining - amount,
      used: used + amount,
      limit: limit
    };
  } catch (error) {
    console.error('Error checking company resource pool:', error);
    return { allowed: false, reason: 'Błąd sprawdzania limitów' };
  }
}

/**
 * Wykorzystuje zasób z puli firmowej
 * @param {String} userId - ID użytkownika
 * @param {String} resourceType - 'aiQueries', 'fastTrack', 'providerResponses'
 * @param {Number} amount - Ilość do wykorzystania (domyślnie 1)
 * @returns {Object} { success: Boolean, message: String }
 */
async function consumeCompanyResource(userId, resourceType, amount = 1) {
  try {
    const check = await canUseCompanyResource(userId, resourceType, amount);
    
    if (!check.allowed) {
      return { success: false, message: check.reason };
    }
    
    const user = await User.findById(userId).populate('company');
    const company = await Company.findById(user.company._id);
    
    if (!company || !company.resourcePool) {
      return { success: false, message: 'Firma nie ma włączonego resource pooling' };
    }
    
    // Jeśli limit = 0 (nielimitowane), nie zwiększaj used
    if (company.resourcePool[`${resourceType}Limit`] === 0) {
      return { success: true, message: 'Zasób wykorzystany (nielimitowane)' };
    }
    
    company.resourcePool[`${resourceType}Used`] = (company.resourcePool[`${resourceType}Used`] || 0) + amount;
    await company.save();
    
    return { 
      success: true, 
      message: 'Zasób wykorzystany',
      remaining: check.remaining - amount,
      used: company.resourcePool[`${resourceType}Used`],
      limit: company.resourcePool[`${resourceType}Limit`]
    };
  } catch (error) {
    console.error('Error consuming company resource:', error);
    return { success: false, message: 'Błąd wykorzystania zasobu' };
  }
}

/**
 * Pobiera statystyki puli zasobów firmy
 * @param {String} companyId - ID firmy
 * @returns {Object} Statystyki puli zasobów
 */
async function getCompanyResourcePoolStats(companyId) {
  try {
    const company = await Company.findById(companyId);
    
    if (!company || !company.resourcePool) {
      return null;
    }
    
    const pool = company.resourcePool;
    const now = new Date();
    
    // Sprawdź czy trzeba zresetować limity
    ['aiQueries', 'fastTrack', 'providerResponses'].forEach(resourceType => {
      const resetDate = pool[`${resourceType}ResetDate`];
      if (!resetDate || resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
        pool[`${resourceType}Used`] = 0;
        pool[`${resourceType}ResetDate`] = new Date(now.getFullYear(), now.getMonth(), 1);
      }
    });
    
    await company.save();
    
    return {
      aiQueries: {
        limit: pool.aiQueriesLimit || 0,
        used: pool.aiQueriesUsed || 0,
        remaining: pool.aiQueriesLimit === 0 ? Infinity : Math.max(0, (pool.aiQueriesLimit || 0) - (pool.aiQueriesUsed || 0)),
        resetDate: pool.aiQueriesResetDate
      },
      fastTrack: {
        limit: pool.fastTrackLimit || 0,
        used: pool.fastTrackUsed || 0,
        remaining: pool.fastTrackLimit === 0 ? Infinity : Math.max(0, (pool.fastTrackLimit || 0) - (pool.fastTrackUsed || 0)),
        resetDate: pool.fastTrackResetDate
      },
      providerResponses: {
        limit: pool.providerResponsesLimit || 0,
        used: pool.providerResponsesUsed || 0,
        remaining: pool.providerResponsesLimit === 0 ? Infinity : Math.max(0, (pool.providerResponsesLimit || 0) - (pool.providerResponsesUsed || 0)),
        resetDate: pool.providerResponsesResetDate
      },
      allocationStrategy: pool.allocationStrategy || 'equal',
      priorityMembers: pool.priorityMembers || [],
      manualAllocations: pool.manualAllocations || []
    };
  } catch (error) {
    console.error('Error getting company resource pool stats:', error);
    return null;
  }
}

/**
 * Inicjalizuje resource pool dla firmy na podstawie planu subskrypcji
 * @param {String} companyId - ID firmy
 * @param {String} planKey - Klucz planu (BUSINESS_FREE, BUSINESS_STANDARD, BUSINESS_PRO)
 */
async function initializeCompanyResourcePool(companyId, planKey) {
  try {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new Error('Firma nie znaleziona');
    }
    
    // Pobierz plan subskrypcji
    const SubscriptionPlan = require('../models/SubscriptionPlan');
    const plan = await SubscriptionPlan.findOne({ key: planKey });
    
    if (!plan) {
      throw new Error('Plan subskrypcji nie znaleziony');
    }
    
    // Ustaw limity na podstawie planu biznesowego (większe niż dla indywidualnych providerów)
    // BUSINESS_FREE: 100 AI queries, 0 Fast-Track, 20 responses (więcej niż PROV_FREE: 50 AI, 10 responses)
    // BUSINESS_STANDARD: 1000 AI queries, 20 Fast-Track, 200 responses (więcej niż PROV_STD: 500 AI, 50 responses)
    // BUSINESS_PRO: nielimitowane (999999)
    const limits = {
      BUSINESS_FREE: {
        aiQueriesLimit: 100,
        fastTrackLimit: 0,
        providerResponsesLimit: 20
      },
      BUSINESS_STANDARD: {
        aiQueriesLimit: 1000,
        fastTrackLimit: 20,
        providerResponsesLimit: 200
      },
      BUSINESS_PRO: {
        aiQueriesLimit: 999999, // Nielimitowane
        fastTrackLimit: 999999, // Nielimitowane
        providerResponsesLimit: 999999 // Nielimitowane
      }
    };
    
    const planLimits = limits[planKey] || limits.BUSINESS_FREE;
    
    if (!company.resourcePool) {
      company.resourcePool = {};
    }
    
    const now = new Date();
    company.resourcePool.aiQueriesLimit = planLimits.aiQueriesLimit;
    company.resourcePool.aiQueriesUsed = 0;
    company.resourcePool.aiQueriesResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
    
    company.resourcePool.fastTrackLimit = planLimits.fastTrackLimit;
    company.resourcePool.fastTrackUsed = 0;
    company.resourcePool.fastTrackResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
    
    company.resourcePool.providerResponsesLimit = planLimits.providerResponsesLimit;
    company.resourcePool.providerResponsesUsed = 0;
    company.resourcePool.providerResponsesResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
    
    company.resourcePool.allocationStrategy = company.resourcePool.allocationStrategy || 'equal';
    
    await company.save();
    
    return { success: true, message: 'Resource pool zainicjalizowany' };
  } catch (error) {
    console.error('Error initializing company resource pool:', error);
    return { success: false, message: error.message };
  }
}

module.exports = {
  canUseCompanyResource,
  consumeCompanyResource,
  getCompanyResourcePoolStats,
  initializeCompanyResourcePool
};

