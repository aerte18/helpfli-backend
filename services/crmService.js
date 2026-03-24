?// Serwis do integracji z CRM (Salesforce, HubSpot, etc.)
const axios = require('axios');
const CrmIntegration = require('../models/CrmIntegration');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');

class CrmService {
  /**
   * Synchronizuje zlecenie z CRM
   * @param {String} integrationId - ID integracji CRM
   * @param {String} orderId - ID zlecenia
   */
  async syncOrder(integrationId, orderId) {
    try {
      const integration = await CrmIntegration.findById(integrationId);
      if (!integration || !integration.isActive) {
        throw new Error('Integracja nie jest aktywna');
      }

      const order = await Order.findById(orderId)
        .populate('client', 'name email phone')
        .populate('provider', 'name email phone')
        .lean();

      if (!order) {
        throw new Error('Zlecenie nie znalezione');
      }

      switch (integration.provider) {
        case 'salesforce':
          return await this.syncToSalesforce(integration, order);
        case 'hubspot':
          return await this.syncToHubSpot(integration, order);
        case 'pipedrive':
          return await this.syncToPipedrive(integration, order);
        default:
          throw new Error(`Nieobsługiwany provider CRM: ${integration.provider}`);
      }
    } catch (error) {
      console.error('CRM_SYNC_ORDER_ERROR:', error);
      throw error;
    }
  }

  /**
   * Synchronizuje zlecenie do Salesforce
   */
  async syncToSalesforce(integration, order) {
    const { accessToken, instanceUrl } = integration.credentials;
    
    if (!accessToken || !instanceUrl) {
      throw new Error('Brak danych autoryzacji Salesforce');
    }

    // 1. Utwórz/zaktualizuj Contact (klient)
    const contactData = {
      FirstName: order.client?.name?.split(' ')[0] || 'Unknown',
      LastName: order.client?.name?.split(' ').slice(1).join(' ') || 'Client',
      Email: order.client?.email || '',
      Phone: order.client?.phone || '',
      Description: `Helpfli Client - Order: ${order._id}`
    };

    let contactId = null;
    try {
      // Sprawdź czy contact już istnieje
      const existingContact = await axios.get(
        `${instanceUrl}/services/data/v57.0/query/?q=SELECT+Id+FROM+Contact+WHERE+Email='${contactData.Email}'`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (existingContact.data.records.length > 0) {
        contactId = existingContact.data.records[0].Id;
        // Aktualizuj contact
        await axios.patch(
          `${instanceUrl}/services/data/v57.0/sobjects/Contact/${contactId}`,
          contactData,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
      } else {
        // Utwórz nowy contact
        const newContact = await axios.post(
          `${instanceUrl}/services/data/v57.0/sobjects/Contact`,
          contactData,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        contactId = newContact.data.id;
      }
    } catch (error) {
      console.error('Salesforce contact sync error:', error.response?.data || error.message);
    }

    // 2. Utwórz Opportunity (deal)
    const opportunityData = {
      Name: `Helpfli Order: ${order.service}`,
      StageName: this.mapOrderStatusToSalesforceStage(order.status),
      Amount: order.amountTotal ? order.amountTotal / 100 : 0,
      CloseDate: order.completedAt || new Date().toISOString().split('T')[0],
      Description: order.description,
      ContactId: contactId
    };

    let opportunityId = null;
    try {
      const opportunity = await axios.post(
        `${instanceUrl}/services/data/v57.0/sobjects/Opportunity`,
        opportunityData,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      opportunityId = opportunity.data.id;
    } catch (error) {
      console.error('Salesforce opportunity sync error:', error.response?.data || error.message);
    }

    // 3. Utwórz Task (jeśli potrzebne)
    if (order.status === 'open' || order.status === 'pending') {
      try {
        await axios.post(
          `${instanceUrl}/services/data/v57.0/sobjects/Task`,
          {
            Subject: `Follow up: Helpfli Order ${order._id}`,
            Status: 'Not Started',
            Priority: order.priority === 'priority' ? 'High' : 'Normal',
            WhatId: opportunityId,
            WhoId: contactId
          },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
      } catch (error) {
        console.error('Salesforce task sync error:', error.response?.data || error.message);
      }
    }

    // Aktualizuj statystyki
    integration.stats.ordersSynced += 1;
    integration.stats.totalSynced += 1;
    integration.stats.lastSyncAt = new Date();
    integration.syncConfig.lastSyncAt = new Date();
    integration.syncConfig.lastSyncStatus = 'success';
    await integration.save();

    return {
      success: true,
      contactId,
      opportunityId,
      message: 'Zlecenie zsynchronizowane z Salesforce'
    };
  }

  /**
   * Synchronizuje zlecenie do HubSpot
   */
  async syncToHubSpot(integration, order) {
    const { apiKey, portalId } = integration.credentials;
    
    if (!apiKey) {
      throw new Error('Brak API Key HubSpot');
    }

    // 1. Utwórz/zaktualizuj Contact
    const contactData = {
      email: order.client?.email || '',
      firstname: order.client?.name?.split(' ')[0] || 'Unknown',
      lastname: order.client?.name?.split(' ').slice(1).join(' ') || 'Client',
      phone: order.client?.phone || ''
    };

    let contactId = null;
    try {
      const contactResponse = await axios.post(
        `https://api.hubapi.com/contacts/v1/contact/createOrUpdate/email/${contactData.email}`,
        { properties: contactData },
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      contactId = contactResponse.data.vid;
    } catch (error) {
      console.error('HubSpot contact sync error:', error.response?.data || error.message);
    }

    // 2. Utwórz Deal
    const dealData = {
      properties: {
        dealname: `Helpfli Order: ${order.service}`,
        dealstage: this.mapOrderStatusToHubSpotStage(order.status),
        amount: order.amountTotal ? String(order.amountTotal / 100) : '0',
        closedate: order.completedAt ? new Date(order.completedAt).getTime() : Date.now(),
        description: order.description
      },
      associations: contactId ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }] : []
    };

    let dealId = null;
    try {
      const dealResponse = await axios.post(
        `https://api.hubapi.com/crm/v3/objects/deals`,
        dealData,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      dealId = dealResponse.data.id;
    } catch (error) {
      console.error('HubSpot deal sync error:', error.response?.data || error.message);
    }

    // Aktualizuj statystyki
    integration.stats.ordersSynced += 1;
    integration.stats.totalSynced += 1;
    integration.stats.lastSyncAt = new Date();
    integration.syncConfig.lastSyncAt = new Date();
    integration.syncConfig.lastSyncStatus = 'success';
    await integration.save();

    return {
      success: true,
      contactId,
      dealId,
      message: 'Zlecenie zsynchronizowane z HubSpot'
    };
  }

  /**
   * Synchronizuje zlecenie do Pipedrive
   */
  async syncToPipedrive(integration, order) {
    const { apiToken } = integration.credentials;
    
    if (!apiToken) {
      throw new Error('Brak API Token Pipedrive');
    }

    // 1. Utwórz/zaktualizuj Person
    const personData = {
      name: order.client?.name || 'Unknown Client',
      email: [{ value: order.client?.email || '', primary: true }],
      phone: [{ value: order.client?.phone || '', primary: true }]
    };

    let personId = null;
    try {
      const personResponse = await axios.post(
        `https://api.pipedrive.com/v1/persons?api_token=${apiToken}`,
        personData
      );
      personId = personResponse.data.data.id;
    } catch (error) {
      console.error('Pipedrive person sync error:', error.response?.data || error.message);
    }

    // 2. Utwórz Deal
    const dealData = {
      title: `Helpfli Order: ${order.service}`,
      person_id: personId,
      value: order.amountTotal ? order.amountTotal / 100 : 0,
      currency: 'PLN',
      stage_id: this.mapOrderStatusToPipedriveStage(order.status),
      note: order.description
    };

    let dealId = null;
    try {
      const dealResponse = await axios.post(
        `https://api.pipedrive.com/v1/deals?api_token=${apiToken}`,
        dealData
      );
      dealId = dealResponse.data.data.id;
    } catch (error) {
      console.error('Pipedrive deal sync error:', error.response?.data || error.message);
    }

    // Aktualizuj statystyki
    integration.stats.ordersSynced += 1;
    integration.stats.totalSynced += 1;
    integration.stats.lastSyncAt = new Date();
    integration.syncConfig.lastSyncAt = new Date();
    integration.syncConfig.lastSyncStatus = 'success';
    await integration.save();

    return {
      success: true,
      personId,
      dealId,
      message: 'Zlecenie zsynchronizowane z Pipedrive'
    };
  }

  /**
   * Mapuje status zlecenia na stage Salesforce
   */
  mapOrderStatusToSalesforceStage(status) {
    const mapping = {
      'open': 'Prospecting',
      'pending': 'Qualification',
      'accepted': 'Needs Analysis',
      'in_progress': 'Value Proposition',
      'completed': 'Closed Won',
      'closed': 'Closed Won',
      'cancelled': 'Closed Lost'
    };
    return mapping[status] || 'Prospecting';
  }

  /**
   * Mapuje status zlecenia na stage HubSpot
   */
  mapOrderStatusToHubSpotStage(status) {
    const mapping = {
      'open': 'appointmentscheduled',
      'pending': 'qualifiedtobuy',
      'accepted': 'presentationscheduled',
      'in_progress': 'decisionmakerboughtin',
      'completed': 'closedwon',
      'closed': 'closedwon',
      'cancelled': 'closedlost'
    };
    return mapping[status] || 'appointmentscheduled';
  }

  /**
   * Mapuje status zlecenia na stage Pipedrive
   */
  mapOrderStatusToPipedriveStage(status) {
    // Pipedrive używa ID stage'ów, więc zwracamy domyślny (można skonfigurować)
    const mapping = {
      'open': 1,
      'pending': 2,
      'accepted': 3,
      'in_progress': 4,
      'completed': 5,
      'closed': 5,
      'cancelled': 6
    };
    return mapping[status] || 1;
  }

  /**
   * Odświeża token Salesforce
   */
  async refreshSalesforceToken(integration) {
    try {
      const { clientId, clientSecret, refreshToken } = integration.credentials;
      
      const response = await axios.post(
        'https://login.salesforce.com/services/oauth2/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken
        })
      );

      integration.credentials.accessToken = response.data.access_token;
      integration.credentials.instanceUrl = response.data.instance_url;
      await integration.save();

      return response.data.access_token;
    } catch (error) {
      console.error('Salesforce token refresh error:', error);
      throw error;
    }
  }
}

module.exports = new CrmService();













