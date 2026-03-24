const cron = require('node-cron');
const dayjs = require('dayjs');
const Company = require('../models/Company');
const { generateMonthlyInvoice } = require('../utils/companyWallet');
const NotificationService = require('../services/NotificationService');

/**
 * Cron job do automatycznego generowania miesięcznych faktur dla firm
 * Uruchamiany 1. dnia miesiąca o 9:00 rano (dla poprzedniego miesiąca)
 */
function startMonthlyCompanyInvoices() {
  if (String(process.env.ENABLE_MONTHLY_COMPANY_INVOICES || 'true') !== 'true') {
    console.log('[cron] Monthly company invoices disabled');
    return;
  }

  const spec = process.env.MONTHLY_COMPANY_INVOICES_CRON || '0 9 1 * *'; // 1. dnia miesiąca o 9:00

  cron.schedule(spec, async () => {
    try {
      console.log('[MonthlyCompanyInvoices] Starting monthly invoice generation for previous month...');
      
      const now = dayjs();
      const lastMonth = now.subtract(1, 'month');
      const periodStart = lastMonth.startOf('month').toDate();
      const periodEnd = lastMonth.endOf('month').toDate();

      // Znajdź wszystkie aktywne firmy
      const companies = await Company.find({
        status: 'active',
        verified: true
      }).lean();

      console.log(`[MonthlyCompanyInvoices] Found ${companies.length} active companies`);

      let generated = 0;
      const errors = [];

      for (const company of companies) {
        try {
          const result = await generateMonthlyInvoice(
            company._id,
            periodStart,
            periodEnd,
            {
              type: 'monthly_summary',
              notes: `Automatyczna faktura miesięczna za ${lastMonth.format('YYYY-MM')}`
            }
          );

          if (result.success) {
            generated++;
            console.log(`[MonthlyCompanyInvoices] Generated invoice for company ${company.name} (${company._id})`);

            // Powiadom właściciela firmy
            try {
              await NotificationService.sendNotification(
                'company_invoice_generated',
                [company.owner],
                {
                  companyName: company.name,
                  invoiceNumber: result.invoice.invoiceNumber,
                  period: `${dayjs(periodStart).format('YYYY-MM-DD')} - ${dayjs(periodEnd).format('YYYY-MM-DD')}`,
                  amount: (result.invoice.summary.total / 100).toFixed(2)
                }
              );
            } catch (notifyErr) {
              console.error(`[MonthlyCompanyInvoices] Notification error for company ${company._id}:`, notifyErr);
            }
          } else {
            errors.push({
              companyId: company._id,
              companyName: company.name,
              error: result.error || 'Unknown error'
            });
            console.warn(`[MonthlyCompanyInvoices] Failed to generate invoice for company ${company.name}: ${result.error}`);
          }
        } catch (error) {
          errors.push({
            companyId: company._id,
            companyName: company.name,
            error: error.message
          });
          console.error(`[MonthlyCompanyInvoices] Error generating invoice for company ${company._id}:`, error);
        }
      }

      console.log(`[MonthlyCompanyInvoices] Generated ${generated} invoices, ${errors.length} errors`);
      
      if (errors.length > 0) {
        console.error('[MonthlyCompanyInvoices] Errors:', errors);
      }
    } catch (error) {
      console.error('[MonthlyCompanyInvoices] Cron job error:', error);
    }
  }, { 
    timezone: process.env.REPORTS_TZ || 'Europe/Warsaw' 
  });

  console.log('[cron] Monthly company invoices scheduled:', spec);
}

module.exports = { startMonthlyCompanyInvoices };

