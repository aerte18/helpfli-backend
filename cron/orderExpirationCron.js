/**
 * Cron job do automatycznego zarządzania wygasaniem zleceń przez AI
 * - Automatyczne wydłużanie zleceń bez ofert
 * - Automatyczne skracanie zleceń gdy jest dużo aktywnych providerów
 * - Inteligentna analiza na podstawie lokalizacji, historii i typu usługi
 */

const cron = require('node-cron');
const logger = require('../utils/logger');

// Opóźnione ładowanie modułów (lazy load) aby uniknąć problemów podczas startu serwera
let orderExpirationAI = null;
function getOrderExpirationAI() {
  if (!orderExpirationAI) {
    try {
      orderExpirationAI = require('../utils/orderExpirationAI');
    } catch (error) {
      logger.error('Error loading orderExpirationAI module:', error);
      throw error;
    }
  }
  return orderExpirationAI;
}

/**
 * Uruchamia zarządzanie wygasaniem zleceń
 * Może być wywołane ręcznie lub przez cron
 */
async function runOrderExpirationManagement() {
  try {
    logger.info('🔄 Starting order expiration management...');
    const { manageOrderExpiration } = getOrderExpirationAI();
    const result = await manageOrderExpiration();
    
    logger.info(`✅ Order expiration management completed:`, {
      processed: result.processed,
      extended: result.extended,
      shortened: result.shortened
    });
    
    // Log szczegółów jeśli były zmiany
    if (result.results && result.results.length > 0) {
      logger.debug(`   Extended orders: ${result.extended}`);
      logger.debug(`   Shortened orders: ${result.shortened}`);
      
      // Log pierwszych kilku zmian
      result.results.slice(0, 5).forEach(r => {
        logger.debug(`   - Order ${r.orderId}: ${r.action} - ${r.reason}`);
      });
    }
    
    return result;
  } catch (error) {
    logger.error('❌ Error in order expiration management:', error);
    throw error;
  }
}

/**
 * Rejestruje cron job do automatycznego zarządzania wygasaniem
 * Uruchamiane co godzinę (o :00 każdej godziny)
 */
function scheduleOrderExpirationCron() {
  // Uruchamiaj co godzinę o :00 (np. 00:00, 01:00, 02:00, etc.)
  cron.schedule('0 * * * *', async () => {
    try {
      await runOrderExpirationManagement();
    } catch (error) {
      logger.error('Cron job error in order expiration management:', error);
    }
  }, { 
    timezone: 'Europe/Warsaw' 
  });
  
  logger.info('✅ Order expiration cron job scheduled (every hour at :00)');
  
  // Opcjonalnie: uruchom raz od razu przy starcie (tylko w dev)
  if (process.env.NODE_ENV === 'development' && process.env.RUN_EXPIRATION_ON_START === '1') {
    logger.info('🔄 Running order expiration management on start (dev mode)...');
    runOrderExpirationManagement().catch(error => {
      logger.error('Error running expiration management on start:', error);
    });
  }
}

module.exports = {
  runOrderExpirationManagement,
  scheduleOrderExpirationCron
};

