// Zarządzanie integracjami z systemami księgowymi
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const AccountingIntegration = require('../models/AccountingIntegration');
const accountingService = require('../services/accountingService');

// POST /api/accounting/integrations - Utwórz nową integrację
router.post('/integrations', authMiddleware, async (req, res) => {
  try {
    const { provider, credentials, syncConfig, companyId } = req.body;
    const userId = req.user._id;

    const existing = await AccountingIntegration.findOne({ 
      user: userId, 
      provider,
      ...(companyId ? { company: companyId } : { company: null })
    });

    if (existing) {
      return res.status(400).json({ message: 'Integracja z tym providerem już istnieje' });
    }

    const integration = await AccountingIntegration.create({
      user: userId,
      company: companyId || null,
      provider,
      credentials,
      syncConfig: syncConfig || {
        syncInvoices: true,
        syncPayments: true,
        autoSync: true
      },
      status: 'pending',
      isActive: false
    });

    res.status(201).json({
      integration: {
        _id: integration._id,
        provider: integration.provider,
        status: integration.status,
        isActive: integration.isActive
      },
      message: 'Integracja utworzona. Wymaga aktywacji.'
    });
  } catch (error) {
    console.error('CREATE_ACCOUNTING_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd tworzenia integracji' });
  }
});

// GET /api/accounting/integrations - Lista integracji
router.get('/integrations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const { companyId } = req.query;

    const query = { user: userId };
    if (companyId) query.company = companyId;

    const integrations = await AccountingIntegration.find(query)
      .select('-credentials')
      .sort({ createdAt: -1 });

    res.json({ integrations });
  } catch (error) {
    console.error('GET_ACCOUNTING_INTEGRATIONS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania integracji' });
  }
});

// POST /api/accounting/integrations/:integrationId/sync/:paymentId - Synchronizuj fakturę
router.post('/integrations/:integrationId/sync/:paymentId', authMiddleware, async (req, res) => {
  try {
    const { integrationId, paymentId } = req.params;
    const userId = req.user._id;

    const integration = await AccountingIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ message: 'Integracja nie jest aktywna' });
    }

    const result = await accountingService.syncInvoice(integrationId, paymentId);

    res.json(result);
  } catch (error) {
    console.error('ACCOUNTING_SYNC_INVOICE_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd synchronizacji faktury' });
  }
});

// GET /api/accounting/integrations/:integrationId/export - Eksport faktur
router.get('/integrations/:integrationId/export', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const { format = 'csv', from, to } = req.query;
    const userId = req.user._id;

    const integration = await AccountingIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    const exported = await accountingService.exportInvoices(integrationId, format, from, to);

    res.setHeader('Content-Type', format === 'csv' ? 'text/csv' : 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="invoices_${Date.now()}.${format}"`);
    res.send(exported);
  } catch (error) {
    console.error('EXPORT_INVOICES_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd eksportu faktur' });
  }
});

// PATCH /api/accounting/integrations/:integrationId - Aktualizuj integrację
router.patch('/integrations/:integrationId', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;
    const { syncConfig, credentials, notes } = req.body;

    const integration = await AccountingIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    if (syncConfig) {
      integration.syncConfig = { ...integration.syncConfig, ...syncConfig };
    }
    if (credentials) {
      integration.credentials = { ...integration.credentials, ...credentials };
    }
    if (notes !== undefined) {
      integration.notes = notes;
    }

    await integration.save();

    res.json({
      integration: {
        _id: integration._id,
        provider: integration.provider,
        status: integration.status,
        isActive: integration.isActive
      }
    });
  } catch (error) {
    console.error('UPDATE_ACCOUNTING_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktualizacji integracji' });
  }
});

// POST /api/accounting/integrations/:integrationId/activate - Aktywuj integrację
router.post('/integrations/:integrationId/activate', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;

    const integration = await AccountingIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    const hasCredentials = this.validateCredentials(integration);
    if (!hasCredentials) {
      return res.status(400).json({ message: 'Brak kompletnych danych autoryzacji' });
    }

    integration.isActive = true;
    integration.status = 'active';
    await integration.save();

    res.json({
      message: 'Integracja aktywowana',
      integration: {
        _id: integration._id,
        provider: integration.provider,
        status: integration.status,
        isActive: integration.isActive
      }
    });
  } catch (error) {
    console.error('ACTIVATE_ACCOUNTING_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktywacji integracji' });
  }
});

// DELETE /api/accounting/integrations/:integrationId - Usuń integrację
router.delete('/integrations/:integrationId', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;

    const integration = await AccountingIntegration.findOneAndDelete({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    res.json({ message: 'Integracja usunięta' });
  } catch (error) {
    console.error('DELETE_ACCOUNTING_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd usuwania integracji' });
  }
});

// Helper do walidacji credentials
function validateCredentials(integration) {
  const { provider, credentials } = integration;
  
  switch (provider) {
    case 'wfirma':
      return !!(credentials.apiKey && credentials.apiSecret);
    case 'enova':
      return !!(credentials.username && credentials.password && credentials.companyId);
    case 'comarch':
      return !!(credentials.apiKey && credentials.apiUrl);
    default:
      return false;
  }
}

module.exports = router;













