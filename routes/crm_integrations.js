// Zarządzanie integracjami CRM
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const CrmIntegration = require('../models/CrmIntegration');
const crmService = require('../services/crmService');
const User = require('../models/User');

// POST /api/crm/integrations - Utwórz nową integrację CRM
router.post('/integrations', authMiddleware, async (req, res) => {
  try {
    const { provider, credentials, syncConfig, companyId } = req.body;
    const userId = req.user._id;

    // Sprawdź czy integracja z tym providerem już istnieje
    const existing = await CrmIntegration.findOne({ 
      user: userId, 
      provider,
      ...(companyId ? { company: companyId } : { company: null })
    });

    if (existing) {
      return res.status(400).json({ message: 'Integracja z tym providerem już istnieje' });
    }

    const integration = await CrmIntegration.create({
      user: userId,
      company: companyId || null,
      provider,
      credentials,
      syncConfig: syncConfig || {
        syncOrders: true,
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
      message: 'Integracja utworzona. Wymaga aktywacji przez administratora.'
    });
  } catch (error) {
    console.error('CREATE_CRM_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd tworzenia integracji CRM' });
  }
});

// GET /api/crm/integrations - Lista integracji użytkownika
router.get('/integrations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const { companyId } = req.query;

    const query = { user: userId };
    if (companyId) query.company = companyId;

    const integrations = await CrmIntegration.find(query)
      .select('-credentials') // Nie zwracamy credentials
      .sort({ createdAt: -1 });

    res.json({ integrations });
  } catch (error) {
    console.error('GET_CRM_INTEGRATIONS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania integracji' });
  }
});

// GET /api/crm/integrations/:integrationId - Szczegóły integracji
router.get('/integrations/:integrationId', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;

    const integration = await CrmIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    // Nie zwracamy pełnych credentials (tylko status)
    res.json({
      integration: {
        _id: integration._id,
        provider: integration.provider,
        status: integration.status,
        isActive: integration.isActive,
        syncConfig: integration.syncConfig,
        stats: integration.stats,
        createdAt: integration.createdAt
      }
    });
  } catch (error) {
    console.error('GET_CRM_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania integracji' });
  }
});

// PATCH /api/crm/integrations/:integrationId - Aktualizuj integrację
router.patch('/integrations/:integrationId', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;
    const { syncConfig, credentials, notes } = req.body;

    const integration = await CrmIntegration.findOne({ 
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
        isActive: integration.isActive,
        syncConfig: integration.syncConfig
      }
    });
  } catch (error) {
    console.error('UPDATE_CRM_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktualizacji integracji' });
  }
});

// POST /api/crm/integrations/:integrationId/activate - Aktywuj integrację
router.post('/integrations/:integrationId/activate', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;

    const integration = await CrmIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    // Sprawdź czy credentials są kompletne
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
    console.error('ACTIVATE_CRM_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktywacji integracji' });
  }
});

// POST /api/crm/integrations/:integrationId/sync/:orderId - Synchronizuj zlecenie
router.post('/integrations/:integrationId/sync/:orderId', authMiddleware, async (req, res) => {
  try {
    const { integrationId, orderId } = req.params;
    const userId = req.user._id;

    const integration = await CrmIntegration.findOne({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ message: 'Integracja nie jest aktywna' });
    }

    const result = await crmService.syncOrder(integrationId, orderId);

    res.json(result);
  } catch (error) {
    console.error('CRM_SYNC_ORDER_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd synchronizacji zlecenia' });
  }
});

// DELETE /api/crm/integrations/:integrationId - Usuń integrację
router.delete('/integrations/:integrationId', authMiddleware, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const userId = req.user._id;

    const integration = await CrmIntegration.findOneAndDelete({ 
      _id: integrationId, 
      user: userId 
    });

    if (!integration) {
      return res.status(404).json({ message: 'Integracja nie znaleziona' });
    }

    res.json({ message: 'Integracja usunięta' });
  } catch (error) {
    console.error('DELETE_CRM_INTEGRATION_ERROR:', error);
    res.status(500).json({ message: 'Błąd usuwania integracji' });
  }
});

// Helper do walidacji credentials
function validateCredentials(integration) {
  const { provider, credentials } = integration;
  
  switch (provider) {
    case 'salesforce':
      return !!(credentials.accessToken && credentials.instanceUrl);
    case 'hubspot':
      return !!credentials.apiKey;
    case 'pipedrive':
      return !!credentials.apiToken;
    default:
      return false;
  }
}

module.exports = router;













