const cron = require('node-cron');
const dayjs = require('dayjs');
const { generatePreviousMonthInvoices } = require('../utils/clientMonthlyInvoices');

/**
 * Cron job do automatycznego generowania miesięcznych faktur dla klientów
 * Uruchamiany 1. dnia miesiąca o 8:00 rano (dla poprzedniego miesiąca)
 */
function startMonthlyClientInvoices() {
  if (String(process.env.ENABLE_MONTHLY_CLIENT_INVOICES || 'true') !== 'true') {
    console.log('[cron] Monthly client invoices disabled');
    return;
  }

  const spec = process.env.MONTHLY_CLIENT_INVOICES_CRON || '0 8 1 * *'; // 1. dnia miesiąca o 8:00

  cron.schedule(spec, async () => {
    try {
      console.log('[MonthlyClientInvoices] Starting monthly invoice generation for previous month...');
      const result = await generatePreviousMonthInvoices();
      console.log(`[MonthlyClientInvoices] Generated ${result.generated} invoices, ${result.errors.length} errors`);
      
      if (result.errors.length > 0) {
        console.error('[MonthlyClientInvoices] Errors:', result.errors);
      }
    } catch (error) {
      console.error('[MonthlyClientInvoices] Cron job error:', error);
    }
  }, { 
    timezone: process.env.REPORTS_TZ || 'Europe/Warsaw' 
  });

  console.log('[cron] Monthly client invoices scheduled:', spec);
}

module.exports = { startMonthlyClientInvoices };

