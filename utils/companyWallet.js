const CompanyWallet = require('../models/CompanyWallet');
const Company = require('../models/Company');
const Order = require('../models/Order');
const Payment = require('../models/Payment');

/**
 * Pobiera lub tworzy portfel firmowy
 * @param {String} companyId - ID firmy
 * @returns {Object} CompanyWallet
 */
async function getOrCreateWallet(companyId) {
  let wallet = await CompanyWallet.findOne({ company: companyId });
  
  if (!wallet) {
    wallet = await CompanyWallet.create({
      company: companyId,
      balance: 0
    });
  }
  
  return wallet;
}

/**
 * Doładowuje portfel firmowy
 * @param {String} companyId - ID firmy
 * @param {Number} amount - Kwota w groszach
 * @param {Object} options - Opcje (paymentId, userId, description)
 * @returns {Object} { success: Boolean, wallet: CompanyWallet, newBalance: Number }
 */
async function depositToWallet(companyId, amount, options = {}) {
  try {
    const wallet = await getOrCreateWallet(companyId);
    
    await wallet.addTransaction('deposit', amount, {
      description: options.description || 'Doładowanie portfela',
      paymentId: options.paymentId || null,
      userId: options.userId || null,
      metadata: options.metadata || {}
    });
    
    return {
      success: true,
      wallet,
      newBalance: wallet.balance
    };
  } catch (error) {
    console.error('Error depositing to wallet:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Pobiera środki z portfela firmowego
 * @param {String} companyId - ID firmy
 * @param {Number} amount - Kwota w groszach
 * @param {Object} options - Opcje (orderId, userId, description)
 * @returns {Object} { success: Boolean, wallet: CompanyWallet, newBalance: Number }
 */
async function withdrawFromWallet(companyId, amount, options = {}) {
  try {
    const wallet = await getOrCreateWallet(companyId);
    
    // Sprawdź czy można wypłacić
    if (!wallet.canAfford(amount)) {
      return {
        success: false,
        error: 'Niewystarczające środki w portfelu',
        balance: wallet.balance
      };
    }
    
    await wallet.addTransaction('withdrawal', -amount, {
      description: options.description || 'Wypłata z portfela',
      orderId: options.orderId || null,
      userId: options.userId || null,
      metadata: options.metadata || {}
    });
    
    return {
      success: true,
      wallet,
      newBalance: wallet.balance
    };
  } catch (error) {
    console.error('Error withdrawing from wallet:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Płatność z portfela firmowego
 * @param {String} companyId - ID firmy
 * @param {Number} amount - Kwota w groszach
 * @param {Object} options - Opcje (orderId, paymentId, userId, description, type)
 * @returns {Object} { success: Boolean, wallet: CompanyWallet, newBalance: Number }
 */
async function payFromWallet(companyId, amount, options = {}) {
  try {
    const wallet = await getOrCreateWallet(companyId);
    
    // Sprawdź czy można zapłacić
    if (!wallet.canAfford(amount)) {
      return {
        success: false,
        error: 'Niewystarczające środki w portfelu',
        balance: wallet.balance,
        requiresRecharge: true
      };
    }
    
    const transactionType = options.type || 'payment';
    
    await wallet.addTransaction(transactionType, -amount, {
      description: options.description || 'Płatność z portfela',
      orderId: options.orderId || null,
      paymentId: options.paymentId || null,
      userId: options.userId || null,
      metadata: options.metadata || {}
    });
    
    return {
      success: true,
      wallet,
      newBalance: wallet.balance
    };
  } catch (error) {
    console.error('Error paying from wallet:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Dodaje przychód do portfela firmowego (np. z zleceń)
 * @param {String} companyId - ID firmy
 * @param {Number} amount - Kwota w groszach
 * @param {Object} options - Opcje (orderId, userId, description)
 * @returns {Object} { success: Boolean, wallet: CompanyWallet, newBalance: Number }
 */
async function addRevenueToWallet(companyId, amount, options = {}) {
  try {
    const wallet = await getOrCreateWallet(companyId);
    
    await wallet.addTransaction('order_revenue', amount, {
      description: options.description || 'Przychód z zlecenia',
      orderId: options.orderId || null,
      userId: options.userId || null,
      metadata: options.metadata || {}
    });
    
    return {
      success: true,
      wallet,
      newBalance: wallet.balance
    };
  } catch (error) {
    console.error('Error adding revenue to wallet:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Uwaga: Funkcja generateMonthlyInvoice została usunięta
// Faktury są teraz wystawiane przez KSeF
// Firmy mogą pobierać rozliczenia (settlements) do własnych celów księgowych

module.exports = {
  getOrCreateWallet,
  depositToWallet,
  withdrawFromWallet,
  payFromWallet,
  addRevenueToWallet
};







