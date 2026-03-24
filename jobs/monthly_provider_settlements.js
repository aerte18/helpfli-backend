const cron = require('node-cron');
const { generateMonthlySettlements } = require('../utils/providerSettlements');

/**
 * Cron job do automatycznego generowania miesięcznych rozliczeń dla providerów
 * Uruchamiany 1. dnia miesiąca o 7:00 rano (dla poprzedniego miesiąca)
 * Automatycznie generuje self-billing faktury dla providerów z włączonym samofakturowaniem
 */
function startMonthlyProviderSettlements() {
  if (String(process.env.ENABLE_MONTHLY_PROVIDER_SETTLEMENTS || 'true') !== 'true') {
    console.log('[cron] Monthly provider settlements disabled');
    return;
  }

  const spec = process.env.MONTHLY_PROVIDER_SETTLEMENTS_CRON || '0 7 1 * *'; // 1. dnia miesiąca o 7:00

  cron.schedule(spec, async () => {
    try {
      console.log('[MonthlyProviderSettlements] Starting monthly settlements generation for previous month...');
      await generateMonthlySettlements();
      console.log('[MonthlyProviderSettlements] Monthly settlements generation completed');
    } catch (error) {
      console.error('[MonthlyProviderSettlements] Cron job error:', error);
    }
  }, { 
    timezone: process.env.REPORTS_TZ || 'Europe/Warsaw' 
  });

  console.log('[cron] Monthly provider settlements scheduled:', spec);
}

module.exports = { startMonthlyProviderSettlements };

