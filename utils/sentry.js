const Sentry = require('@sentry/node');

function sanitizeEvent(event) {
  // Remove common PII
  if (event?.request) {
    if (event.request.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    if (event.request.data && typeof event.request.data === 'object') {
      const redact = (obj) => {
        for (const k of Object.keys(obj)) {
          const key = k.toLowerCase();
          if (['password','pass','token','authorization','auth','secret','email'].includes(key)) {
            obj[k] = '[redacted]';
          } else if (obj[k] && typeof obj[k] === 'object') {
            redact(obj[k]);
          }
        }
      };
      redact(event.request.data);
    }
  }
  return event;
}


let nodeProfilingIntegration = () => undefined;
try {
  const profilingEnabled = process.env.ENABLE_SENTRY_PROFILING !== '0';
  const profilingSupported = process.platform !== 'win32';
  if (process.env.SENTRY_DSN && profilingEnabled && profilingSupported) {
    ({ nodeProfilingIntegration } = require('@sentry/profiling-node'));
  } else if (process.env.SENTRY_DSN && profilingEnabled && !profilingSupported) {
    console.warn('Sentry profiling disabled on Windows (unsupported binary).');
  }
} catch (e) {
  console.warn('Sentry profiling disabled (module not available):', e?.message || e);
}

// Initialize Sentry
function initSentry(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('Sentry disabled - no SENTRY_DSN');
    return { enabled: false };
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      integrations: [
        ...(process.env.ENABLE_SENTRY_PROFILING === '0' ? [] : [nodeProfilingIntegration && nodeProfilingIntegration()].filter(Boolean)),
      ],
      // Performance Monitoring
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      // Set sampling rate for profiling - this is relative to tracesSampleRate
      profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      
      // Capture unhandled promise rejections
      captureUnhandledRejections: true,
      
      // Capture uncaught exceptions
      captureUncaughtException: true,
      
      // Set release version
      release: process.env.npm_package_version || '1.0.0',
      
      // Filter out sensitive data
      beforeSend: sanitizeEvent,
    });
  } catch (e) {
    console.warn('⚠️ Sentry disabled - invalid SENTRY_DSN or init error:', e?.message || e);
    return { enabled: false };
  }

  if (app) {
    app.use(Sentry.Handlers.requestHandler());
  }
  
  console.log('✅ Sentry initialized');
  return { enabled: true };
}

// Express middleware for Sentry
function sentryMiddleware() {
  // setupExpressErrorHandler nie istnieje w nowszych wersjach Sentry
  // Używamy requestHandler zamiast tego
  return Sentry.Handlers.requestHandler();
}

// Error handler middleware
function sentryErrorHandler() {
  return Sentry.Handlers.errorHandler();
}

// Capture exceptions manually
function captureException(error, context = {}) {
  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      // Add context
      Object.keys(context).forEach(key => {
        scope.setContext(key, context[key]);
      });
      
      Sentry.captureException(error);
    });
  }
}

// Capture messages manually
function captureMessage(message, level = 'info', context = {}) {
  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      // Add context
      Object.keys(context).forEach(key => {
        scope.setContext(key, context[key]);
      });
      
      Sentry.captureMessage(message, level);
    });
  }
}

// Set user context
function setUserContext(user) {
  if (process.env.SENTRY_DSN && user) {
    Sentry.setUser({
      id: user._id || user.id,
      role: user.role,
      // Don't include sensitive data
    });
  }
}

// Set tags
function setTag(key, value) {
  if (process.env.SENTRY_DSN) {
    Sentry.setTag(key, value);
  }
}

// Set context
function setContext(key, context) {
  if (process.env.SENTRY_DSN) {
    Sentry.setContext(key, context);
  }
}

module.exports = {
  initSentry,
  sentryMiddleware,
  sentryErrorHandler,
  captureException,
  captureMessage,
  setUserContext,
  setTag,
  setContext,
  Sentry
};
