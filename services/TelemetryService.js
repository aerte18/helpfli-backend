const Event = require('../models/Event');
const User = require('../models/User');

class TelemetryService {
  constructor() {
    this.eventTypes = {
      // Page views
      PAGE_VIEW: 'page_view',
      PROVIDER_VIEW: 'provider_view',
      ORDER_VIEW: 'order_view',
      
      // User actions
      SEARCH: 'search',
      FILTER_APPLIED: 'filter_applied',
      CATEGORY_SELECTED: 'category_selected',
      
      // Provider actions
      PROVIDER_CONTACT: 'provider_contact',
      PROVIDER_COMPARE: 'provider_compare',
      QUOTE_REQUEST: 'quote_request',
      
      // Order flow
      ORDER_CREATED: 'order_created',
      ORDER_ACCEPTED: 'order_accepted',
      ORDER_STARTED: 'order_started',
      ORDER_COMPLETED: 'order_completed',
      // Funnel: tworzenie zlecenia (gdzie użytkownik rezygnuje)
      ORDER_FORM_START: 'order_form_start',
      ORDER_STEP_VIEW: 'order_step_view',
      ORDER_FORM_ABANDON: 'order_form_abandon',
      ORDER_FORM_SUCCESS: 'order_form_success',
      // Funnel: składanie oferty
      OFFER_FORM_START: 'offer_form_start',
      OFFER_STEP_VIEW: 'offer_step_view',
      OFFER_FORM_SUBMIT: 'offer_form_submit',
      OFFER_FORM_PREFLIGHT_BLOCKED: 'offer_form_preflight_blocked',
      OFFER_FORM_PREFLIGHT_OVERRIDE: 'offer_form_preflight_override',
      PROVIDER_AI_MESSAGE_PREFLIGHT_BLOCKED: 'provider_ai_message_preflight_blocked',
      PROVIDER_AI_MESSAGE_PREFLIGHT_OVERRIDE: 'provider_ai_message_preflight_override',
      PROVIDER_AI_MESSAGE_SENT: 'provider_ai_message_sent',
      
      // Payment flow
      PAYMENT_INTENT_CREATED: 'payment_intent_created',
      PAYMENT_SUCCEEDED: 'payment_succeeded',
      PAYMENT_FAILED: 'payment_failed',
      
      // User engagement
      LOGIN: 'login',
      REGISTER: 'register',
      ONBOARDING_COMPLETED: 'onboarding_completed',
      
      // Disputes
      DISPUTE_REPORTED: 'dispute_reported',
      REFUND_REQUESTED: 'refund_requested',

      // Frontend / reliability
      CLIENT_API_ERROR: 'client_api_error'
    };
  }

  // Główna metoda do rejestrowania eventów
  async track(eventType, data = {}) {
    try {
      const event = new Event({
        type: eventType,
        userId: data.userId || null,
        sessionId: data.sessionId || null,
        properties: {
          ...data.properties,
          timestamp: new Date(),
          userAgent: data.userAgent || null,
          ip: data.ip || null,
          referrer: data.referrer || null
        },
        metadata: data.metadata || {}
      });

      await event.save();
      
      // Log dla developmentu
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Telemetry] ${eventType}:`, data.properties);
      }
      
      return event;
    } catch (error) {
      console.error('Telemetry tracking error:', error);
      // Nie rzucamy błędu, żeby nie przerwać głównej funkcjonalności
    }
  }

  // Helper metody dla konkretnych eventów
  async trackPageView(path, userId = null, sessionId = null) {
    return this.track(this.eventTypes.PAGE_VIEW, {
      userId,
      sessionId,
      properties: {
        path,
        page: this.extractPageName(path)
      }
    });
  }

  async trackProviderView(providerId, userId = null, sessionId = null) {
    return this.track(this.eventTypes.PROVIDER_VIEW, {
      userId,
      sessionId,
      properties: {
        providerId,
        viewType: 'profile'
      }
    });
  }

  async trackSearch(query, filters = {}, userId = null, sessionId = null) {
    return this.track(this.eventTypes.SEARCH, {
      userId,
      sessionId,
      properties: {
        query,
        filters,
        resultCount: 0 // Będzie uzupełnione przez frontend
      }
    });
  }

  async trackFilterApplied(filterType, filterValue, userId = null, sessionId = null) {
    return this.track(this.eventTypes.FILTER_APPLIED, {
      userId,
      sessionId,
      properties: {
        filterType,
        filterValue
      }
    });
  }

  async trackCategorySelected(categoryId, categoryName, userId = null, sessionId = null) {
    return this.track(this.eventTypes.CATEGORY_SELECTED, {
      userId,
      sessionId,
      properties: {
        categoryId,
        categoryName
      }
    });
  }

  async trackProviderContact(providerId, contactType, userId = null, sessionId = null) {
    return this.track(this.eventTypes.PROVIDER_CONTACT, {
      userId,
      sessionId,
      properties: {
        providerId,
        contactType // 'phone', 'message', 'quote'
      }
    });
  }

  async trackProviderCompare(providerIds, userId = null, sessionId = null) {
    return this.track(this.eventTypes.PROVIDER_COMPARE, {
      userId,
      sessionId,
      properties: {
        providerIds,
        compareCount: providerIds.length
      }
    });
  }

  async trackOrderCreated(orderId, service, userId = null, sessionId = null) {
    return this.track(this.eventTypes.ORDER_CREATED, {
      userId,
      sessionId,
      properties: {
        orderId,
        service,
        orderType: 'manual'
      }
    });
  }

  async trackOrderAccepted(orderId, providerId, userId = null, sessionId = null) {
    return this.track(this.eventTypes.ORDER_ACCEPTED, {
      userId,
      sessionId,
      properties: {
        orderId,
        providerId,
        acceptedBy: userId
      }
    });
  }

  async trackPaymentSucceeded(orderId, amount, paymentMethod, userId = null, sessionId = null) {
    return this.track(this.eventTypes.PAYMENT_SUCCEEDED, {
      userId,
      sessionId,
      properties: {
        orderId,
        amount,
        paymentMethod,
        currency: 'PLN'
      }
    });
  }

  async trackLogin(userId, loginMethod = 'email', sessionId = null) {
    return this.track(this.eventTypes.LOGIN, {
      userId,
      sessionId,
      properties: {
        loginMethod,
        userRole: null // Będzie uzupełnione przez backend
      }
    });
  }

  async trackRegister(userId, userRole, registrationMethod = 'email', sessionId = null) {
    return this.track(this.eventTypes.REGISTER, {
      userId,
      sessionId,
      properties: {
        userRole,
        registrationMethod
      }
    });
  }

  // Helper do wyciągnięcia nazwy strony z path
  extractPageName(path) {
    const segments = path.split('/').filter(s => s);
    if (segments.length === 0) return 'home';
    return segments[0];
  }

  // Metody do agregacji danych
  async getEventStats(eventType, startDate, endDate) {
    const pipeline = [
      {
        $match: {
          type: eventType,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 0,
          count: 1,
          uniqueUsers: { $size: '$uniqueUsers' }
        }
      }
    ];

    const result = await Event.aggregate(pipeline);
    return result[0] || { count: 0, uniqueUsers: 0 };
  }

  async getPopularPages(startDate, endDate, limit = 10) {
    const pipeline = [
      {
        $match: {
          type: this.eventTypes.PAGE_VIEW,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$properties.path',
          views: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 0,
          path: '$_id',
          views: 1,
          uniqueUsers: { $size: '$uniqueUsers' }
        }
      },
      { $sort: { views: -1 } },
      { $limit: limit }
    ];

    return Event.aggregate(pipeline);
  }

  async getConversionFunnel(startDate, endDate) {
    const funnelTypes = [
      this.eventTypes.PAGE_VIEW,
      this.eventTypes.SEARCH,
      this.eventTypes.PROVIDER_VIEW,
      this.eventTypes.PROVIDER_CONTACT,
      this.eventTypes.QUOTE_REQUEST,
      this.eventTypes.ORDER_CREATED,
      this.eventTypes.ORDER_FORM_START,
      this.eventTypes.ORDER_FORM_SUCCESS,
      this.eventTypes.ORDER_ACCEPTED,
      this.eventTypes.PAYMENT_SUCCEEDED,
      this.eventTypes.OFFER_FORM_START,
      this.eventTypes.OFFER_FORM_SUBMIT
    ];
    const pipeline = [
      {
        $match: {
          type: { $in: funnelTypes },
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 }
        }
      }
    ];

    return Event.aggregate(pipeline);
  }

  async getConversionFunnelDetailed(startDate, endDate) {
    const funnelTypes = [
      this.eventTypes.PAGE_VIEW,
      this.eventTypes.SEARCH,
      this.eventTypes.PROVIDER_VIEW,
      this.eventTypes.PROVIDER_CONTACT,
      this.eventTypes.QUOTE_REQUEST,
      this.eventTypes.ORDER_FORM_START,
      this.eventTypes.ORDER_FORM_SUCCESS,
      this.eventTypes.OFFER_FORM_START,
      this.eventTypes.OFFER_FORM_SUBMIT,
      this.eventTypes.ORDER_ACCEPTED,
      this.eventTypes.PAYMENT_SUCCEEDED
    ];

    const overall = await Event.aggregate([
      { $match: { type: { $in: funnelTypes }, createdAt: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          uniqueUsers: { $size: { $setDifference: ['$uniqueUsers', [null]] } }
        }
      }
    ]);

    const byRole = await Event.aggregate([
      { $match: { type: { $in: funnelTypes }, createdAt: { $gte: startDate, $lte: endDate }, userId: { $ne: null } } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      {
        $addFields: {
          roleGroup: {
            $cond: [
              { $in: ['$user.role', ['provider', 'company_owner', 'company_manager']] },
              'provider',
              {
                $cond: [{ $eq: ['$user.role', 'client'] }, 'client', 'other']
              }
            ]
          }
        }
      },
      { $match: { roleGroup: { $in: ['client', 'provider'] } } },
      {
        $group: {
          _id: { type: '$type', role: '$roleGroup' },
          count: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          uniqueUsers: { $size: '$uniqueUsers' }
        }
      }
    ]);

    const client = [];
    const provider = [];
    byRole.forEach((item) => {
      if (item?._id?.role === 'client') client.push({ _id: item._id.type, count: item.count, uniqueUsers: item.uniqueUsers });
      if (item?._id?.role === 'provider') provider.push({ _id: item._id.type, count: item.count, uniqueUsers: item.uniqueUsers });
    });

    return { overall, client, provider };
  }
}

module.exports = new TelemetryService();

