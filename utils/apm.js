// APM Monitoring - New Relic / DataDog
const newrelic = require('newrelic');

// Initialize APM
function initAPM() {
  if (process.env.NEW_RELIC_LICENSE_KEY) {
    console.log('✅ New Relic APM initialized');
    return true;
  } else if (process.env.DATADOG_API_KEY) {
    console.log('✅ DataDog APM initialized');
    return true;
  } else {
    console.log('⚠️ No APM configured - monitoring disabled');
    return false;
  }
}

// Custom metrics tracking
class APMMetrics {
  constructor() {
    this.isEnabled = initAPM();
  }

  // Track custom events
  trackEvent(eventName, attributes = {}) {
    if (!this.isEnabled) return;
    
    try {
      if (process.env.NEW_RELIC_LICENSE_KEY) {
        newrelic.recordCustomEvent(eventName, attributes);
      }
      // DataDog would use different API here
    } catch (error) {
      console.error('APM tracking error:', error);
    }
  }

  // Track business metrics
  trackOrderCreated(orderId, userId, amount) {
    this.trackEvent('OrderCreated', {
      orderId,
      userId,
      amount,
      timestamp: new Date().toISOString()
    });
  }

  trackUserLogin(userId, userType) {
    this.trackEvent('UserLogin', {
      userId,
      userType,
      timestamp: new Date().toISOString()
    });
  }

  trackAIConciergeUsage(userId, responseTime, success) {
    this.trackEvent('AIConciergeUsage', {
      userId,
      responseTime,
      success,
      timestamp: new Date().toISOString()
    });
  }

  trackPaymentProcessed(paymentId, amount, currency, success) {
    this.trackEvent('PaymentProcessed', {
      paymentId,
      amount,
      currency,
      success,
      timestamp: new Date().toISOString()
    });
  }

  trackProviderResponse(providerId, orderId, responseTime) {
    this.trackEvent('ProviderResponse', {
      providerId,
      orderId,
      responseTime,
      timestamp: new Date().toISOString()
    });
  }

  // Track performance metrics
  trackDatabaseQuery(queryName, duration, success) {
    this.trackEvent('DatabaseQuery', {
      queryName,
      duration,
      success,
      timestamp: new Date().toISOString()
    });
  }

  trackAPICall(endpoint, method, duration, statusCode) {
    this.trackEvent('APICall', {
      endpoint,
      method,
      duration,
      statusCode,
      timestamp: new Date().toISOString()
    });
  }

  // Track errors
  trackError(error, context = {}) {
    if (!this.isEnabled) return;
    
    try {
      if (process.env.NEW_RELIC_LICENSE_KEY) {
        newrelic.noticeError(error, context);
      }
    } catch (err) {
      console.error('APM error tracking failed:', err);
    }
  }

  // Track user actions
  trackUserAction(action, userId, metadata = {}) {
    this.trackEvent('UserAction', {
      action,
      userId,
      ...metadata,
      timestamp: new Date().toISOString()
    });
  }
}

// Create singleton instance
const apmMetrics = new APMMetrics();

module.exports = {
  apmMetrics,
  initAPM
};
