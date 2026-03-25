// Serwis do integracji z systemami księgowymi
const axios = require('axios');
const AccountingIntegration = require('../models/AccountingIntegration');
const Payment = require('../models/Payment');
const Order = require('../models/Order');

class AccountingService {
  /**
   * Synchronizuje fakturę z systemem księgowym
   * @param {String} integrationId - ID integracji
   * @param {String} paymentId - ID płatności (faktury)
   */
  async syncInvoice(integrationId, paymentId) {
    try {
      const integration = await AccountingIntegration.findById(integrationId);
      if (!integration || !integration.isActive) {
        throw new Error('Integracja nie jest aktywna');
      }

      const payment = await Payment.findById(paymentId)
        .populate('provider', 'name email nip')
        .populate('client', 'name email nip')
        .populate('order')
        .lean();

      if (!payment) {
        throw new Error('Płatność nie znaleziona');
      }

      switch (integration.provider) {
        case 'wfirma':
          return await this.syncToWFirma(integration, payment);
        case 'enova':
          return await this.syncToEnova(integration, payment);
        case 'comarch':
          return await this.syncToComarch(integration, payment);
        default:
          throw new Error(`Nieobsługiwany provider: ${integration.provider}`);
      }
    } catch (error) {
      console.error('ACCOUNTING_SYNC_INVOICE_ERROR:', error);
      throw error;
    }
  }

  /**
   * Synchronizuje fakturę do wFirma
   */
  async syncToWFirma(integration, payment) {
    const { apiKey, apiSecret } = integration.credentials;
    
    if (!apiKey || !apiSecret) {
      throw new Error('Brak danych autoryzacji wFirma');
    }

    // Przygotuj dane faktury
    const invoiceData = {
      numer: `HELPFLI-${payment._id}`,
      data_wystawienia: new Date(payment.createdAt).toISOString().split('T')[0],
      data_sprzedazy: new Date(payment.createdAt).toISOString().split('T')[0],
      termin_platnosci: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      kontrahent: {
        nazwa: payment.provider?.name || 'Unknown',
        nip: payment.provider?.nip || '',
        email: payment.provider?.email || ''
      },
      pozycje: [{
        nazwa: `Usługa Helpfli - ${payment.purpose}`,
        ilosc: 1,
        cena: payment.amount / 100,
        vat: 23 // 23% VAT
      }],
      uwagi: `Zlecenie: ${payment.order?._id || 'N/A'}`
    };

    try {
      const response = await axios.post(
        'https://api.wfirma.pl/invoices/add',
        invoiceData,
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // Aktualizuj statystyki
      integration.stats.invoicesSynced += 1;
      integration.stats.totalSynced += 1;
      integration.stats.lastSyncAt = new Date();
      integration.syncConfig.lastSyncAt = new Date();
      integration.syncConfig.lastSyncStatus = 'success';
      await integration.save();

      return {
        success: true,
        invoiceId: response.data.invoice?.id,
        invoiceNumber: response.data.invoice?.number,
        message: 'Faktura zsynchronizowana z wFirma'
      };
    } catch (error) {
      integration.stats.errors += 1;
      integration.syncConfig.lastSyncStatus = 'error';
      integration.syncConfig.lastSyncError = error.response?.data?.message || error.message;
      await integration.save();
      throw error;
    }
  }

  /**
   * Synchronizuje fakturę do Enova
   */
  async syncToEnova(integration, payment) {
    const { username, password, companyId } = integration.credentials;
    
    if (!username || !password || !companyId) {
      throw new Error('Brak danych autoryzacji Enova');
    }

    // Enova używa własnego formatu API
    const invoiceData = {
      companyId,
      documentType: 'FV', // Faktura VAT
      number: `HELPFLI-${payment._id}`,
      issueDate: new Date(payment.createdAt).toISOString().split('T')[0],
      saleDate: new Date(payment.createdAt).toISOString().split('T')[0],
      contractor: {
        name: payment.provider?.name || 'Unknown',
        nip: payment.provider?.nip || '',
        email: payment.provider?.email || ''
      },
      items: [{
        name: `Usługa Helpfli - ${payment.purpose}`,
        quantity: 1,
        netPrice: (payment.amount / 100) / 1.23, // Cena netto
        vatRate: 23
      }],
      notes: `Zlecenie: ${payment.order?._id || 'N/A'}`
    };

    try {
      // Przykładowe wywołanie API Enova (może wymagać dostosowania)
      const response = await axios.post(
        'https://api.enova.pl/v1/documents',
        invoiceData,
        {
          auth: { username, password },
          headers: { 'Content-Type': 'application/json' }
        }
      );

      integration.stats.invoicesSynced += 1;
      integration.stats.totalSynced += 1;
      integration.stats.lastSyncAt = new Date();
      integration.syncConfig.lastSyncAt = new Date();
      integration.syncConfig.lastSyncStatus = 'success';
      await integration.save();

      return {
        success: true,
        invoiceId: response.data.id,
        invoiceNumber: response.data.number,
        message: 'Faktura zsynchronizowana z Enova'
      };
    } catch (error) {
      integration.stats.errors += 1;
      integration.syncConfig.lastSyncStatus = 'error';
      integration.syncConfig.lastSyncError = error.response?.data?.message || error.message;
      await integration.save();
      throw error;
    }
  }

  /**
   * Synchronizuje fakturę do Comarch
   */
  async syncToComarch(integration, payment) {
    const { apiKey, apiUrl } = integration.credentials;
    
    if (!apiKey || !apiUrl) {
      throw new Error('Brak danych autoryzacji Comarch');
    }

    const invoiceData = {
      documentType: 'FV',
      number: `HELPFLI-${payment._id}`,
      issueDate: new Date(payment.createdAt).toISOString().split('T')[0],
      contractor: {
        name: payment.provider?.name || 'Unknown',
        nip: payment.provider?.nip || '',
        email: payment.provider?.email || ''
      },
      items: [{
        name: `Usługa Helpfli - ${payment.purpose}`,
        quantity: 1,
        netPrice: (payment.amount / 100) / 1.23,
        vatRate: 23
      }]
    };

    try {
      const response = await axios.post(
        `${apiUrl}/api/invoices`,
        invoiceData,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      integration.stats.invoicesSynced += 1;
      integration.stats.totalSynced += 1;
      integration.stats.lastSyncAt = new Date();
      integration.syncConfig.lastSyncAt = new Date();
      integration.syncConfig.lastSyncStatus = 'success';
      await integration.save();

      return {
        success: true,
        invoiceId: response.data.id,
        invoiceNumber: response.data.number,
        message: 'Faktura zsynchronizowana z Comarch'
      };
    } catch (error) {
      integration.stats.errors += 1;
      integration.syncConfig.lastSyncStatus = 'error';
      integration.syncConfig.lastSyncError = error.response?.data?.message || error.message;
      await integration.save();
      throw error;
    }
  }

  /**
   * Eksportuje faktury do pliku (CSV/XML)
   */
  async exportInvoices(integrationId, format = 'csv', from, to) {
    try {
      const integration = await AccountingIntegration.findById(integrationId);
      if (!integration) {
        throw new Error('Integracja nie znaleziona');
      }

      const query = {
        provider: { $in: integration.company ? await this.getCompanyProviders(integration.company) : [integration.user] },
        status: 'succeeded',
        createdAt: {}
      };

      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);

      const payments = await Payment.find(query).lean();

      if (format === 'csv') {
        return this.exportToCSV(payments);
      } else if (format === 'xml') {
        return this.exportToXML(payments);
      }

      throw new Error('Nieobsługiwany format eksportu');
    } catch (error) {
      console.error('EXPORT_INVOICES_ERROR:', error);
      throw error;
    }
  }

  exportToCSV(payments) {
    const headers = ['Numer faktury', 'Data', 'Klient', 'Kwota', 'VAT', 'Status'];
    const rows = payments.map(p => [
      `HELPFLI-${p._id}`,
      new Date(p.createdAt).toISOString().split('T')[0],
      p.clientName || 'Unknown',
      (p.amount / 100).toFixed(2),
      ((p.amount / 100) * 0.23).toFixed(2),
      p.status
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  exportToXML(payments) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<invoices>
${payments.map(p => `  <invoice>
    <number>HELPFLI-${p._id}</number>
    <date>${new Date(p.createdAt).toISOString().split('T')[0]}</date>
    <client>${p.clientName || 'Unknown'}</client>
    <amount>${(p.amount / 100).toFixed(2)}</amount>
    <vat>${((p.amount / 100) * 0.23).toFixed(2)}</vat>
    <status>${p.status}</status>
  </invoice>`).join('\n')}
</invoices>`;
    return xml;
  }

  async getCompanyProviders(companyId) {
    const Company = require('../models/Company');
    const company = await Company.findById(companyId).lean();
    return [
      company.owner,
      ...(company.managers || []),
      ...(company.providers || [])
    ];
  }
}

module.exports = new AccountingService();













