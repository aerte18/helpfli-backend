// server.js
require('dotenv').config();

// Initialize Sentry first (before any other imports) – optional in serverless
let initSentry = () => {};
let sentryErrorHandler = () => (_err, _req, _res, _next) => {};
let sentryMiddleware = () => (_req, _res, _next) => next();
try {
  const s = require('./utils/sentry');
  initSentry = s.initSentry || initSentry;
  sentryErrorHandler = s.sentryErrorHandler || sentryErrorHandler;
  sentryMiddleware = s.sentryMiddleware || sentryMiddleware;
} catch {}

// Initialize Winston logger
const logger = require('./utils/logger');

// Walidacja zmiennych środowiskowych
const { validateEnv } = require('./utils/validateEnv');
validateEnv();

// Fallback dla zmiennych środowiskowych jeśli .env nie działa
// Uwaga: W produkcji PORT musi być ustawiony w zmiennych środowiskowych
if (!process.env.PORT) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('❌ ERROR: PORT must be set in production environment');
    process.exit(1);
  }
  process.env.PORT = 5000; // Domyślny port dla development
}
// Accept both MONGO_URI and MONGODB_URI (Atlas default var name)
if (!process.env.MONGO_URI && process.env.MONGODB_URI) process.env.MONGO_URI = process.env.MONGODB_URI;
// Nie ustawiaj lokalnego URI na Vercel – powoduje time-outy funkcji
if (process.env.VERCEL !== '1') {
  if (!process.env.MONGO_URI) process.env.MONGO_URI = 'mongodb://localhost:27017/helpfli';
}
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'your-super-secret-jwt-key-here';
if (!process.env.CORS_ORIGIN && process.env.NODE_ENV !== 'production') {
  process.env.CORS_ORIGIN = 'http://localhost:5174';
}

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const IS_VERCEL = process.env.VERCEL === '1';
const { 
  authLimiter, 
  registerLimiter, 
  apiLimiter, 
  searchLimiter, 
  speedLimiter,
  telemetryLimiter,
  uploadLimiter
} = require('./middleware/rateLimiter');

// Safe require helper for serverless – if module fails to load, use empty router
const safeRequire = (p) => {
  try { 
    const result = require(p);
    // Jeśli moduł się załadował, sprawdź czy router ma poprawne routy
    if (result && typeof result === 'function') {
      // Router jest funkcją - OK
      return result;
    }
    return result;
  } catch (e) { 
    // Jeśli błąd jest związany z path-to-regexp, pokaż więcej informacji
    if (e.message && e.message.includes('Missing parameter name')) {
      logger.error(`\n❌❌❌ CRITICAL ERROR in route file: ${p}`);
      logger.error(`   This file has a route with invalid parameter syntax!`);
      logger.error(`   Look for routes with ':' followed by space or invalid characters`);
      logger.error(`   Error: ${e.message}`);
      if (e.stack) {
        const stackLines = e.stack.split('\n').slice(0, 10);
        stackLines.forEach(line => logger.error(`   ${line}`));
      }
      process.exit(1); // Zatrzymaj serwer, żeby użytkownik mógł naprawić błąd
    }
    logger.warn('[serverless] Skipping module', p, '-', e.message); 
    return express.Router(); 
  }
};

// Ładowanie routów z lepszą obsługą błędów
const loadRoute = (name, path) => {
  try {
    logger.debug(`Loading route: ${name}...`);
    // Wyczyść cache modułu przed załadowaniem (dla development)
    if (process.env.NODE_ENV !== 'production') {
      delete require.cache[require.resolve(path)];
    }
    const route = require(path);
    logger.debug(`✅ Route ${name} loaded successfully`);
    return route;
  } catch (e) {
    if (e.message && e.message.includes('Missing parameter name')) {
      logger.error(`\n❌❌❌ CRITICAL ERROR in route: ${name} (${path})`);
      logger.error(`   This route file has invalid parameter syntax!`);
      logger.error(`   Look for routes with ':' followed by space or invalid characters`);
      logger.error(`   Error: ${e.message}`);
      if (e.stack) {
        const stackLines = e.stack.split('\n').slice(0, 15);
        stackLines.forEach(line => logger.error(`   ${line}`));
      }
      throw e; // Rzuć błąd dalej, żeby zatrzymać serwer
    }
    logger.warn(`⚠️  Skipping route ${name}: ${e.message}`);
    return express.Router();
  }
};

const chatSocket = loadRoute('chatSocket', './sockets/chatSocket');
const chatRoutes = loadRoute('chat', './routes/chat');
const authRoutes = loadRoute('auth', './routes/auth');
const ordersRoutes = loadRoute('orders', './routes/orders');
const recommendedOrdersRoutes = loadRoute('recommendedOrders', './routes/recommendedOrders');
const servicesRoutes = loadRoute('services', './routes/services');
const searchRoutes = loadRoute('search', './routes/search');
const aiRoutes = loadRoute('ai', './routes/ai');
const usersRoutes = loadRoute('users', './routes/users');
const providersRoutes = loadRoute('providers', './routes/providers');
const promoCodeRoutes = loadRoute('promo_codes', './routes/promo_codes');
const subscriptionRoutes = loadRoute('subscriptions', './routes/subscriptions');
const checkoutRoutes = loadRoute('checkout', './routes/checkout');
const metricsRoutes = loadRoute('metrics', './routes/metrics');
const promoCheckout = loadRoute('promo_checkout', './routes/promo_checkout');
const sponsorMetrics = loadRoute('sponsor_metrics', './routes/sponsor_metrics');
const sponsorRoutes = loadRoute('sponsor', './routes/sponsor');
const sponsorCheckout = loadRoute('sponsor_checkout', './routes/sponsor_checkout');
const sponsorAdsRoutes = loadRoute('sponsorAds', './routes/sponsorAds');
const sponsorAdsPixelRoutes = loadRoute('sponsorAdsPixel', './routes/sponsorAdsPixel');
const sponsorAdsPaymentRoutes = loadRoute('sponsorAdsPayment', './routes/sponsorAdsPayment');
const sponsorAdsConversionRoutes = loadRoute('sponsorAdsConversion', './routes/sponsorAdsConversion');
const adminPromos = loadRoute('adminPromos', './routes/adminPromos');
const adminConfigRoutes = loadRoute('adminConfig', './routes/adminConfig');
const kbRoutes = loadRoute('kb', './routes/kb');
const adminVerifications = safeRequire('./routes/admin/verifications');
const adminRoutes = safeRequire('./routes/admin');
const boostsRoutes = safeRequire('./routes/boosts');
const pointsRoutes = safeRequire('./routes/points');
const verificationRoutes = safeRequire('./routes/verification');
const reportsRoutes = safeRequire('./routes/reports');
const guaranteeRoutes = safeRequire('./routes/guarantee');
const categoriesRoutes = safeRequire('./routes/categories');
const userStatsRoutes = safeRequire('./routes/userStats');
const cron = require('node-cron');
const { resetMonthlyExpress } = require('./utils/subscriptionCron');
let stripeWebhook = null;
try { stripeWebhook = require('./routes/stripe_webhook'); } catch {}
const bodyParser = require('body-parser');
const promoAutoRenew = loadRoute('promo_autorenew', './routes/promo_autorenew');
const couponsRoutes = loadRoute('coupons', './routes/coupons');
const { proPackageMiddleware } = require('./middleware/proPackageMiddleware');
const offersRoutes = loadRoute('offers', './routes/offers');
const revenueRoutes = loadRoute('revenue', './routes/revenue');
const verifyRoutes = loadRoute('verify', './routes/verify');
const notificationsRoutes = loadRoute('notifications', './routes/notifications');
const userServicesRoutes = loadRoute('userServices', './routes/userServices');
const proFeaturesRoutes = loadRoute('proFeatures', './routes/proFeatures');
const favoriteClientsRoutes = loadRoute('favoriteClients', './routes/favoriteClients');
const providerStatsRoutes = loadRoute('providerStats', './routes/providerStats');
const providerAiChatRoutes = loadRoute('providerAiChat', './routes/providerAiChat');
const ratingsRoutes = loadRoute('ratings', './routes/ratings');
const messagesRoutes = loadRoute('messages', './routes/messages');
const dashboardRoutes = loadRoute('dashboard', './routes/dashboard');
const announcementsRoutes = loadRoute('announcements', './routes/announcements');
const contactRoutes = loadRoute('contact', './routes/contact');
logger.debug('✅ Dashboard route loaded, creating Express app...');

const app = express();
logger.debug('✅ Express app created');
const server = http.createServer(app);

// Trust proxy for rate limiting
app.set('trust proxy', 1);

// ---------- Sentry Middleware ----------
// Inicjalizacja Sentry (jeśli SENTRY_DSN jest ustawione)
if (process.env.SENTRY_DSN) {
  initSentry(app);
  app.use(sentryMiddleware());
}

// ---------- CORS Configuration ----------
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const cspConnectSrc = [
  "'self'",
  ...allowedOrigins,
  'https://api.stripe.com',
  'https://onesignal.com',
].filter(Boolean);

const isDevelopment = process.env.NODE_ENV !== 'production';

const isAllowedOrigin = (origin) => {
  // Pozwól na brak origin (curl, healthcheck, serwer-serwer)
  if (!origin) return true;

  // Dokładne dopasowanie do listy z env
  if (allowedOrigins.includes(origin)) return true;

  // Dodatkowo localhost tylko w development
  if (isDevelopment && /^http:\/\/localhost:\d+$/.test(origin)) return true;

  return false;
};

const corsOptions = {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) {
      return cb(null, true);
    }

    if (isDevelopment) {
      logger.warn(`⚠️ CORS blocked origin: ${origin}`);
    }

    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cache-Control',
    'Pragma',
    'Expires',
  ],
  exposedHeaders: ['Content-Length']
};

// Zastosuj CORS middleware (tylko raz)
app.use(cors(corsOptions));

// Preflight handler - CORS middleware już obsługuje OPTIONS automatycznie
// Usuwamy app.options('*', ...) bo powoduje błąd z path-to-regexp
// Jeśli potrzebujesz explicit OPTIONS handler, użyj bardziej specyficznych ścieżek
logger.debug('🔵 Skipping explicit OPTIONS handler - CORS middleware handles it automatically');

// Middleware do automatycznej aktywacji funkcji PRO
logger.debug('🔵 About to register proPackageMiddleware...');
app.use(proPackageMiddleware);
logger.debug('🔵 proPackageMiddleware registered');

// Stripe webhook PRZED express.json() (potrzebuje raw body)
logger.debug('🔵 About to register stripeWebhook...');
try { if (stripeWebhook) app.use('/', stripeWebhook); } catch {}
logger.debug('🔵 StripeWebhook registration attempted');

// Cookie parser dla CSRF protection (musi być przed express.json())
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// 1) surowe body dla Stripe webhooka – przed json()
logger.debug('🔵 About to register express.raw for /api/payments/webhook...');
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
logger.debug('🔵 express.raw registered');

app.use(express.json());
app.use(bodyParser.json());

// CSRF Protection (opcjonalne - można włączyć dla formularzy HTML)
// Uwaga: Dla API z JWT w headers CSRF jest mniej krytyczne
if (process.env.ENABLE_CSRF === '1') {
  const { csrfProtection } = require('./middleware/csrf');
  app.use(csrfProtection);
  logger.info('CSRF protection enabled');
}

// Security headers
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://js.stripe.com", "https://cdn.onesignal.com"],
      "connect-src": cspConnectSrc,
      "img-src": ["'self'", "data:", "blob:", "https://*.amazonaws.com"],
      "frame-src": ["https://js.stripe.com"],
      "worker-src": ["'self'", "blob:"]
    }
  }
}));

// Rate limiting middleware (domyślnie WYŁĄCZONE w dev; włącz gdy ENABLE_RATE_LIMIT=1 lub w produkcji)
const ENABLE_RATE_LIMIT = (process.env.ENABLE_RATE_LIMIT === '1') || (process.env.NODE_ENV === 'production');
logger.debug(`ENABLE_RATE_LIMIT: ${ENABLE_RATE_LIMIT} (NODE_ENV=${process.env.NODE_ENV})`);
if (ENABLE_RATE_LIMIT) {
  logger.debug('🔵 About to register speedLimiter...');
  app.use(speedLimiter); // Globalny speed limiter
  logger.debug('🔵 About to register authLimiter at /api/auth/login...');
  app.use('/api/auth/login', authLimiter); // Rate limit dla logowania
  logger.debug('🔵 About to register registerLimiter at /api/auth/register...');
  app.use('/api/auth/register', registerLimiter); // Rate limit dla rejestracji
  logger.debug('🔵 About to register searchLimiter at /api/search...');
  app.use('/api/search', searchLimiter); // Rate limit dla wyszukiwania
  logger.debug('🔵 About to register telemetryLimiter at /api/telemetry...');
  app.use('/api/telemetry', telemetryLimiter); // Rate limit dla telemetry
  logger.debug('🔵 About to register uploadLimiter at /api/upload...');
  app.use('/api/upload', uploadLimiter); // Rate limit dla uploadów
  logger.debug('🔵 About to register apiLimiter at /api...');
  app.use('/api', apiLimiter); // Ogólny rate limit dla API
  logger.debug('🔵 All rate limiters registered');
}

// ---------- MongoDB (opcjonalne) ----------
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || (process.env.VERCEL === '1' ? '' : 'mongodb://localhost:27017/helpfli');
logger.debug(`MONGO_URI: ${mongoUri ? 'configured' : 'not set'}`);

// Współdzielone połączenie (serverless reuse)
let mongoConnectionPromise = null;
function connectMongo() {
  if (mongoConnectionPromise) return mongoConnectionPromise;
  // Na Vercel bez zdefiniowanego zdalnego URI – pomijamy łączenie z DB
  if (!mongoUri || mongoUri === 'undefined' || (process.env.VERCEL === '1' && /localhost|127\.0\.0\.1/.test(mongoUri))) {
    logger.info('ℹ️ No MongoDB URI provided, running without database');
    return Promise.resolve(null);
  }
  mongoConnectionPromise = mongoose
    .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
      logger.info('✅ MongoDB connected');
      return mongoose;
    })
    .catch(err => {
      logger.warn('⚠️ MongoDB connection failed, continuing without database:', err?.message || err);
      logger.info('ℹ️ Some features may not work without database');
      return null;
    });
  return mongoConnectionPromise;
}

// ---------- Cron Jobs ----------
// require("./jobs/expiringPromos").start(); // tymczasowo wyłączone

// W trybie lokalnym/serwerowym łącz od razu; w Vercel Functions handler wywoła connectMongo()
if (process.env.VERCEL !== '1') {
  connectMongo();
}

// Serwowanie plików uploadów (załączniki czatu + KYC)
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const UPLOAD_DIR_ABS = path.isAbsolute(UPLOAD_DIR)
  ? UPLOAD_DIR
  : path.join(__dirname, UPLOAD_DIR);
if (!fs.existsSync(UPLOAD_DIR_ABS)) fs.mkdirSync(UPLOAD_DIR_ABS, { recursive: true });
for (const sub of ['kyc', 'drafts', 'orders', 'orders/invoices', 'chat']) {
  const p = path.join(UPLOAD_DIR_ABS, sub);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

app.use("/uploads", (req, res, next) => {
  // Allow images/documents from API domain to be embedded by frontend domain.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  next();
}, express.static(UPLOAD_DIR_ABS));

// ---------- Socket.IO (musi być PRZED trasą /api/chat) ----------
let io = null;
if (process.env.VERCEL !== '1') {
  // Socket.IO CORS - użyj tej samej logiki co Express CORS
  const socketCorsOptions = {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow tools/local
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST']
  };
  
  io = new Server(server, { cors: socketCorsOptions });
  // Inicjalizacja logiki Socket.IO
  require("./socket")(io);
  // Udostępnij io w routes
  app.set("io", io);
}

// CRON dla TOP AI
if (process.env.VERCEL !== '1') {
  const { scheduleTopAiCron } = require("./cron/topAi");
  scheduleTopAiCron(io);
}

// ---------- API routes ----------
// Funkcja pomocnicza do bezpiecznej rejestracji routów
const safeUse = (path, router, name) => {
  try {
    logger.debug(`🔵 Registering route: ${name} at ${path}`);
    // Sprawdź czy router jest prawidłowy
    if (!router) {
      logger.warn(`⚠️  Router ${name} is null/undefined, skipping`);
      return;
    }
    // Walidacja ścieżki - sprawdź czy nie jest URL lub nie zawiera nieprawidłowych znaków
    if (typeof path !== 'string') {
      logger.error(`❌ Invalid path type for route ${name}: ${typeof path}`);
      throw new Error(`Invalid path type: ${typeof path}`);
    }
    if (path.startsWith('http://') || path.startsWith('https://')) {
      logger.error(`❌ Path cannot be a URL for route ${name}: ${path}`);
      throw new Error(`Path cannot be a URL: ${path}`);
    }
    // Sprawdź czy ścieżka zawiera nieprawidłowe wzorce parametrów
    if (path.includes(':/') || path.match(/:\s/) || path.match(/:[^a-zA-Z_$]/)) {
      logger.error(`❌ Invalid parameter pattern in path for route ${name}: ${path}`);
      throw new Error(`Invalid parameter pattern in path: ${path}`);
    }
    // Przed rejestracją, sprawdź wszystkie ścieżki w routerze dla nieprawidłowych wzorców
    if (router && router.stack) {
      const checkRoutePath = (routePath, context) => {
        if (!routePath || typeof routePath !== 'string') return;
        // Sprawdź czy ścieżka zawiera nieprawidłowe wzorce parametrów
        if (routePath.includes(':/') || routePath.match(/:\s/) || routePath.match(/:[^a-zA-Z_$]/)) {
          logger.error(`❌ Invalid parameter pattern in route ${name}, ${context}: ${routePath}`);
          throw new Error(`Invalid parameter pattern in route: ${routePath}`);
        }
        // Sprawdź czy ścieżka jest URL
        if (routePath.startsWith('http://') || routePath.startsWith('https://')) {
          logger.error(`❌ Route path cannot be a URL in route ${name}, ${context}: ${routePath}`);
          throw new Error(`Route path cannot be a URL: ${routePath}`);
        }
      };
      
      router.stack.forEach((layer, idx) => {
        try {
          if (layer.route && layer.route.path) {
            checkRoutePath(layer.route.path, `route ${idx}`);
          } else if (layer.name === 'router' && layer.regexp) {
            // To jest zagnieżdżony router - sprawdź jego ścieżkę regexp
            const regexpStr = layer.regexp.toString();
            // Sprawdź czy regexp zawiera nieprawidłowe wzorce (uproszczona weryfikacja)
            if (regexpStr.includes(':/') || regexpStr.match(/:\s/)) {
              logger.warn(`⚠️  Suspicious regexp pattern in nested router ${name}, layer ${idx}`);
            }
          }
        } catch (e) {
          if (e.message && (e.message.includes('Invalid parameter pattern') || e.message.includes('cannot be a URL'))) {
            throw e;
          }
          // Ignoruj inne błędy podczas sprawdzania
        }
      });
    }
    logger.debug(`   Attempting to register route ${name} at path: "${path}"`);
    logger.debug(`   Router type: ${typeof router}, has stack: ${router && router.stack ? 'yes' : 'no'}`);
    if (router && router.stack) {
      logger.debug(`   Router has ${router.stack.length} layers`);
      // Loguj wszystkie trasy w routerze przed rejestracją
      router.stack.forEach((layer, idx) => {
        try {
          if (layer.route && layer.route.path) {
            const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
            logger.debug(`     Layer ${idx}: ${methods} ${layer.route.path}`);
          } else if (layer.name === 'router') {
            logger.debug(`     Layer ${idx}: [NESTED ROUTER]`);
          } else {
            logger.debug(`     Layer ${idx}: [MIDDLEWARE] ${layer.name || 'anonymous'}`);
          }
        } catch (e) {
          logger.warn(`     Layer ${idx}: Error inspecting: ${e.message}`);
        }
      });
    }
    logger.debug(`   Now calling app.use("${path}", router) for ${name}...`);
    app.use(path, router);
    logger.debug(`   ✅ app.use completed for ${name}`);
    logger.debug(`✅ ${name} registered successfully at ${path}`);
  } catch (e) {
    logger.error(`\n❌❌❌ ERROR registering route: ${name} at path: ${path}`);
    logger.error(`   Error message: ${e.message}`);
    logger.error(`   Error type: ${e.constructor.name}`);
    if (e.message && e.message.includes('Missing parameter name')) {
      logger.error(`\n❌❌❌ CRITICAL ERROR - Missing parameter name in route: ${name} at path: ${path}`);
      logger.error(`   This indicates a route path with ':' but no parameter name`);
      logger.error(`   Check the router file for routes like '/:' instead of '/:id'`);
      // Wyświetl wszystkie ścieżki w routerze
      if (router && router.stack) {
        logger.error(`   Routes in this router:`);
        router.stack.forEach((layer, idx) => {
          if (layer.route) {
            logger.error(`     ${idx}: ${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
          } else if (layer.name === 'router' && layer.regexp) {
            logger.error(`     ${idx}: [NESTED ROUTER]`);
          }
        });
      }
      if (e.stack) {
        const stackLines = e.stack.split('\n').slice(0, 20);
        logger.error(`   Stack trace:`);
        stackLines.forEach(line => logger.error(`   ${line}`));
      }
      throw e;
    }
    throw e;
  }
};

// Swagger/OpenAPI Documentation
logger.debug('🔵 About to load Swagger...');
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === '1') {
  try {
    const { swaggerSpec, swaggerUi } = require('./utils/swagger');
    logger.debug('🔵 Swagger loaded, registering /api-docs...');
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Helpfli API Documentation'
    }));
    logger.info('📚 Swagger UI available at /api-docs');
  } catch (e) {
    logger.error('❌ Error loading Swagger:', e.message);
    throw e;
  }
}
logger.debug('🔵 Swagger check completed');

// Health check routes
logger.debug('🔵 About to load health routes...');
const healthRoutes = safeRequire('./routes/health');
logger.debug('🔵 Health routes loaded');
logger.info('✅ All routes loaded, about to start registration...');
logger.debug('🔵🔵🔵 Starting route registration...');
try {
  logger.debug('🔵 Inside try block, registering health...');
  safeUse('/api/health', healthRoutes, 'health');
  logger.debug('Registering kb...');
  safeUse('/api', kbRoutes, 'kb');
  logger.debug('🔵 About to register legacy /health endpoint...');
  app.get('/health', (_req, res) => res.json({ ok: true })); // Legacy endpoint
  logger.debug('🔵 Legacy /health endpoint registered');

  logger.debug('Registering auth...');
  // Debug middleware dla /api/auth/login
  app.use('/api/auth/login', (req, res, next) => {
    logger.debug('🔵 LOGIN_REQUEST:', {
      method: req.method,
      url: req.url,
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      contentType: req.get('content-type'),
      dbState: mongoose.connection.readyState
    });
    next();
  });
  safeUse('/api/auth', authRoutes, 'auth');
  safeUse('/api/orders', recommendedOrdersRoutes, 'recommendedOrders');
  safeUse('/api/orders', ordersRoutes, 'orders');
  safeUse('/api/change-requests', safeRequire('./routes/changeRequests'), 'changeRequests');
  safeUse('/api/services', servicesRoutes, 'services');
  safeUse('/api/search', searchRoutes, 'search');
  safeUse('/api/categories', categoriesRoutes, 'categories');
  safeUse('/api/user', userStatsRoutes, 'userStats');
  safeUse('/api/ai', aiRoutes, 'ai');
  safeUse('/api/ai', loadRoute('chatSuggestReply', './routes/chatSuggestReply'), 'chatSuggestReply');
  safeUse('/api/users', usersRoutes, 'users');
  safeUse('/api/providers', providersRoutes, 'providers');
  safeUse('/api/promo', promoCodeRoutes, 'promo_codes');
  safeUse('/api/subscriptions', subscriptionRoutes, 'subscriptions');
  safeUse('/api/boosts', boostsRoutes, 'boosts');
  safeUse('/api/points', pointsRoutes, 'points');
  safeUse('/api/checkout', checkoutRoutes, 'checkout');
  safeUse('/api/admin/promos', adminPromos, 'adminPromos');
  safeUse('/api/admin/config', adminConfigRoutes, 'adminConfig');
  safeUse('/api/admin/verifications', adminVerifications, 'adminVerifications');
  safeUse('/api/admin/analytics', safeRequire('./routes/admin_analytics'), 'admin_analytics');
  safeUse('/api/admin', adminRoutes, 'admin');
  safeUse('/api/verification', verificationRoutes, 'verification');
  safeUse('/api/reports', reportsRoutes, 'reports');
  safeUse('/api/guarantee', guaranteeRoutes, 'guarantee');
  safeUse('/api/promo', promoCheckout, 'promoCheckout');
  safeUse('/api/promo', promoAutoRenew, 'promoAutoRenew');
  safeUse('/api/coupons', couponsRoutes, 'coupons');
  safeUse('/api/offers', offersRoutes, 'offers');
  safeUse('/api/revenue', revenueRoutes, 'revenue');
  safeUse('/api/verify', verifyRoutes, 'verify');
  safeUse('/api/notifications', notificationsRoutes, 'notifications');
  safeUse('/api/user-services', userServicesRoutes, 'userServices');
  safeUse('/api/pro-features', proFeaturesRoutes, 'proFeatures');
  safeUse('/api/favorite-clients', favoriteClientsRoutes, 'favoriteClients');
  safeUse('/api/provider-stats', providerStatsRoutes, 'providerStats');
  safeUse('/api/provider-ai-chat', providerAiChatRoutes, 'providerAiChat');
  safeUse('/api/ratings', ratingsRoutes, 'ratings');
  safeUse('/api/messages', messagesRoutes, 'messages');
  logger.debug('🔵 About to register dashboard...');
  safeUse('/api/dashboard', dashboardRoutes, 'dashboard');
  logger.debug('🔵 About to register announcements...');
  safeUse('/api/announcements', announcementsRoutes, 'announcements');
  logger.debug('🔵 About to register metrics...');
  safeUse('/api/metrics', metricsRoutes, 'metrics');
  logger.debug('🔵 About to register sponsorMetrics...');
  safeUse('/api/sponsor/metrics', sponsorMetrics, 'sponsorMetrics');
  logger.debug('🔵 About to register sponsorRoutes...');
  safeUse('/api', sponsorRoutes, 'sponsor');
  logger.debug('🔵 About to register sponsorCheckout...');
  safeUse('/api', sponsorCheckout, 'sponsorCheckout');
  logger.debug('🔵 About to register sponsorAdsRoutes...');
  safeUse('/api/sponsor-ads', sponsorAdsRoutes, 'sponsorAds');
  logger.debug('🔵 About to register sponsorAdsPaymentRoutes...');
  safeUse('/api/sponsor-ads', sponsorAdsPaymentRoutes, 'sponsorAdsPayment');
  logger.debug('🔵 About to register sponsorAdsConversionRoutes...');
  safeUse('/api/sponsor-ads', sponsorAdsConversionRoutes, 'sponsorAdsConversion');
  logger.debug('🔵 About to register sponsorAdsPixelRoutes...');
  safeUse('/pixel', sponsorAdsPixelRoutes, 'sponsorAdsPixel');
  logger.debug('🔵✅ sponsorAdsPixelRoutes registered, continuing...');

  // Nowe trasy Pakietu 2
  logger.debug('🔵 About to register payments route...');
  safeUse('/api/payments', loadRoute('payments', './routes/payments'), 'payments');
  logger.debug('🔵 About to register billing route...');
  safeUse('/api/billing', loadRoute('billing', './routes/billing'), 'billing');
  logger.debug('🔵✅ payments + billing registered, continuing...');
  logger.debug('🔵 About to register promotions route...');
  safeUse('/api/promotions', loadRoute('promotions', './routes/promotions'), 'promotions');
  logger.debug('🔵 About to register pro route...');
  safeUse('/api/pro', loadRoute('pro', './routes/pro'), 'pro');
  logger.debug('🔵 About to register kyc route...');
  safeUse('/api/kyc', loadRoute('kyc', './routes/kyc'), 'kyc');
  logger.debug('🔵 About to register favorites route...');
  safeUse('/api/favorites', loadRoute('favorites', './routes/favorites'), 'favorites');
  logger.debug('🔵 About to register telemetry route...');
  safeUse('/api/telemetry', loadRoute('telemetry', './routes/telemetry'), 'telemetry');
  logger.debug('🔵 About to register privacy route...');
  safeUse('/api/privacy', loadRoute('privacy', './routes/privacy'), 'privacy');
  logger.debug('🔵 About to register contact route...');
  safeUse('/api/contact', contactRoutes, 'contact');
  // legacy/extra ratings routes are already handled in routes/ratings.js
  logger.debug('🔵 About to register push route...');
  safeUse('/api/push', loadRoute('push', './routes/push'), 'push');
  // Rejestruj bardziej specyficzne routy PRZED ogólnymi
  // WAŻNE: companyPerformance musi być PIERWSZE, bo ma specyficzny route /:companyId/performance
  // companies musi być PRZED companies_billing i companies_analytics, bo ma wszystkie specyficzne routy przed /:companyId
  logger.debug('🔵 About to register companyPerformance route...');
  safeUse('/api/companies', loadRoute('companyPerformance', './routes/companyPerformance'), 'companyPerformance');
  logger.debug('🔵 About to register companies route...');
  safeUse('/api/companies', loadRoute('companies', './routes/companies'), 'companies');
  logger.debug('🔵 About to register notifications route (duplicate)...');
  safeUse('/api/notifications', loadRoute('notifications', './routes/notifications'), 'notifications');
  logger.debug('🔵 About to register admin_notifications route...');
  safeUse('/api/admin/notifications', loadRoute('admin_notifications', './routes/admin_notifications'), 'admin_notifications');
  logger.debug('🔵 About to register companies_billing route...');
  safeUse('/api/companies', loadRoute('companies_billing', './routes/companies_billing'), 'companies_billing');
  logger.debug('🔵 About to register companies_analytics route...');
  safeUse('/api/companies', loadRoute('companies_analytics', './routes/companies_analytics'), 'companies_analytics');
  logger.debug('🔵 About to register providerSchedule route...');
  safeUse('/api/provider-schedule', loadRoute('providerSchedule', './routes/providerSchedule'), 'providerSchedule');
  logger.debug('🔵 About to register video route...');
  safeUse('/api/video', loadRoute('video', './routes/video'), 'video');
  // Stripe webhook mock (dev only)
  if (process.env.NODE_ENV !== 'production') {
    logger.debug('🔵 About to register stripe_webhook_mock route...');
    safeUse('/api', safeRequire('./routes/stripe_webhook_mock'), 'stripe_webhook_mock');
  }
  logger.debug('🔵 About to register admin.analytics route...');
  safeUse('/api/admin', loadRoute('admin.analytics', './routes/admin.analytics'), 'admin.analytics');
  logger.debug('🔵 About to register admin_analytics route...');
  safeUse('/api/admin/analytics', loadRoute('admin_analytics', './routes/admin_analytics'), 'admin_analytics');
  logger.debug('🔵 About to register admin_reports route...');
  safeUse('/api/admin/reports', loadRoute('admin_reports', './routes/admin_reports'), 'admin_reports');
  logger.debug('🔵 About to register admin_report_logs route...');
  safeUse('/api/admin/reports', loadRoute('admin_report_logs', './routes/admin_report_logs'), 'admin_report_logs');
  logger.debug('🔵 About to register admin_cache route...');
  safeUse('/api/admin/cache', loadRoute('admin_cache', './routes/admin_cache'), 'admin_cache');
  logger.debug('🔵 About to register admin_settings route...');
  safeUse('/api/admin/settings', loadRoute('admin_settings', './routes/admin_settings'), 'admin_settings');
  logger.debug('🔵 About to register promote route...');
  safeUse('/api/promote', loadRoute('promote', './routes/promote'), 'promote');
  // Apply API limiter specifically to AI routes
  logger.debug('🔵 About to apply API limiter to AI routes...');
  app.use('/api/ai', apiLimiter);
  logger.debug('🔵 About to register ai (duplicate) route...');
  safeUse('/api/ai', loadRoute('ai (duplicate)', './routes/ai'), 'ai (duplicate)');
  logger.debug('🔵 About to register ai_concierge route...');
  safeUse('/api/ai', loadRoute('ai_concierge', './routes/ai_concierge'), 'ai_concierge');
  logger.debug('🔵 About to register ai_v2 route (agents)...');
  safeUse('/api/ai', loadRoute('ai_v2', './routes/ai_v2'), 'ai_v2');
  logger.debug('🔵 About to register ai_pricing route...');
  safeUse('/api/ai', loadRoute('ai_pricing', './routes/ai_pricing'), 'ai_pricing');
  logger.debug('🔵 About to register ai_claude route...');
  safeUse('/api/ai', loadRoute('ai_claude', './routes/ai_claude'), 'ai_claude');
  logger.debug('🔵 About to register ai_web_search route...');
  safeUse('/api/ai', loadRoute('ai_web_search', './routes/ai_web_search'), 'ai_web_search');
  logger.debug('🔵 About to register ai_advanced route...');
  safeUse('/api/ai/advanced', loadRoute('ai_advanced', './routes/ai_advanced'), 'ai_advanced');
  safeUse('/api/ai/feedback', loadRoute('ai_feedback', './routes/ai_feedback'), 'ai_feedback');
  safeUse('/api/ai/analytics', loadRoute('ai_analytics', './routes/ai_analytics'), 'ai_analytics');
  safeUse('/api/ai/concierge', loadRoute('ai_stream', './routes/ai_stream'), 'ai_stream');
  safeUse('/api/ai/cache', loadRoute('ai_cache', './routes/ai_cache'), 'ai_cache');
  logger.debug('🔵 About to register announcements route (duplicate)...');
  safeUse('/api/announcements', loadRoute('announcements', './routes/announcements'), 'announcements');

// wstrzyknięcie io do requestu tylko dla tras czatu (pomijane w Vercel)
if (process.env.VERCEL !== '1') {
  app.use('/api/chat', (req, _res, next) => { req.io = io; next(); }, chatRoutes);
}
} catch (e) {
  if (e.message && e.message.includes('Missing parameter name')) {
    logger.error(`\n❌❌❌ CRITICAL ERROR during route registration!`);
    logger.error(`   Error: ${e.message}`);
    if (e.stack) {
      const stackLines = e.stack.split('\n').slice(0, 20);
      stackLines.forEach(line => logger.error(`   ${line}`));
    }
    process.exit(1);
  }
  throw e;
}

// ---------- 404 & error handler ----------
// ---------- Sentry Error Handler ----------
if (process.env.SENTRY_DSN) {
  app.use(sentryErrorHandler());
}

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, req, res, _next) => {
  // Obsługa błędów CORS - zwróć 403 zamiast 500
  if (err.message && err.message.includes('CORS blocked')) {
    logger.warn('CORS error:', { origin: req.get('origin'), url: req.url });
    return res.status(403).json({
      error: 'CORS error',
      message: 'Request blocked by CORS policy'
    });
  }
  
  // Generate error ID for tracking
  const errorId = require('crypto').randomBytes(8).toString('hex');
  
  // Log full error details
  logger.error('Unhandled error:', {
    errorId,
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  
  // Don't expose error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({
    error: 'Server error',
    errorId, // Include error ID for support tracking
    ...(isDevelopment && { 
      message: err.message,
      stack: err.stack 
    })
  });
});

// ---------- Start ----------
// W DEV często chcemy odpalić serwer bez uruchamiania cron/jobów,
// bo joby mogą wymagać dodatkowych plików i zależności.
const ENABLE_JOBS = process.env.ENABLE_JOBS === '1';

let startWeeklyCron = null;
let startMonthlyReport = null;
let startAnomalyAlerts = null;
let startMonthlyClientInvoices = null;
let startMonthlyCompanyInvoices = null;
let startMonthlyProviderSettlements = null;
let sendSubscriptionExpiryNotifications = null;
let handleExpiredSubscriptions = null;
let updateLoyaltyMonths = null;
let checkSponsorAdsStatus = null;
let processSubscriptionOrders = null;

if (ENABLE_JOBS) {
  ({ startWeeklyCron } = require('./jobs/weekly_report'));
  ({ startMonthlyReport } = require('./jobs/monthly_report'));
  ({ startAnomalyAlerts } = require('./jobs/alerts_anomaly'));
  ({ startMonthlyClientInvoices } = require('./jobs/monthly_client_invoices'));
  ({ startMonthlyCompanyInvoices } = require('./jobs/monthly_company_invoices'));
  ({ startMonthlyProviderSettlements } = require('./jobs/monthly_provider_settlements'));
  ({ sendSubscriptionExpiryNotifications } = require('./jobs/subscriptionNotifications'));
  ({ handleExpiredSubscriptions, updateLoyaltyMonths } = require('./utils/subscriptionCron'));
  ({ checkSponsorAdsStatus } = require('./cron/sponsorAdsCron'));
  ({ processSubscriptionOrders } = require('./jobs/subscriptionOrdersCron'));
}
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, '0.0.0.0', () => logger.info(`🚀 Server running on port ${PORT}`));
  if (ENABLE_JOBS) {
    startWeeklyCron();
    startMonthlyReport();
    startAnomalyAlerts();
    startMonthlyClientInvoices();
    startMonthlyCompanyInvoices();
    startMonthlyProviderSettlements();
  
    // Powiadomienia o kończących się subskrypcjach - codziennie o 8:00
    cron.schedule('0 8 * * *', async () => {
      try {
        logger.info('[CRON] Starting subscription expiry notifications...');
        await sendSubscriptionExpiryNotifications();
        logger.info('[CRON] Subscription expiry notifications completed');
      } catch (e) {
        logger.error('[CRON] Subscription expiry notifications error:', e);
      }
    });
  
    // Grace period i automatyczny downgrade - codziennie o 2:00
    cron.schedule('0 2 * * *', async () => {
      try {
        logger.info('[CRON] Starting expired subscriptions handling...');
        await handleExpiredSubscriptions();
        logger.info('[CRON] Expired subscriptions handling completed');
      } catch (e) {
        logger.error('[CRON] Expired subscriptions handling error:', e);
      }
    });
  
    // Aktualizacja loyalty months - codziennie o 1:00
    cron.schedule('0 1 * * *', async () => {
      try {
        logger.info('[CRON] Starting loyalty months update...');
        await updateLoyaltyMonths();
        logger.info('[CRON] Loyalty months update completed');
      } catch (e) {
        logger.error('[CRON] Loyalty months update error:', e);
      }
    });
  
    // Sprawdzanie reklam sponsorowanych - co godzinę
    cron.schedule('0 * * * *', async () => {
      try {
        logger.info('[CRON] Checking sponsor ads status...');
        await checkSponsorAdsStatus();
        logger.info('[CRON] Sponsor ads status check completed');
      } catch (e) {
        logger.error('[CRON] Sponsor ads status check error:', e);
      }
    });
  
    // Automatyczne tworzenie cyklicznych zleceń dla subscription - codziennie o 6:00
    cron.schedule('0 6 * * *', async () => {
      try {
        logger.info('[CRON] Starting subscription orders processing...');
        await processSubscriptionOrders();
        logger.info('[CRON] Subscription orders processing completed');
      } catch (e) {
        logger.error('[CRON] Subscription orders processing error:', e);
      }
    });
  
    // Zarządzanie wygasaniem zleceń przez AI - co godzinę (15 minut po sprawdzaniu reklam)
    try {
      const { scheduleOrderExpirationCron } = require('./cron/orderExpirationCron');
      scheduleOrderExpirationCron();
      logger.info('[CRON] Order expiration management cron scheduled');
    } catch (e) {
      logger.error('[CRON] Error scheduling order expiration cron:', e);
    }
  
    // Powiadomienia o kończących się pakietach promocyjnych - codziennie o 9:05
    try {
      const expiringPromos = require('./jobs/expiringPromos');
      if (expiringPromos.start) {
        expiringPromos.start();
        logger.info('[CRON] Expiring promos job scheduled');
      }
    } catch (e) {
      logger.error('[CRON] Error scheduling expiring promos:', e);
    }

    // Nowe zlecenia dopasowane do wykonawcy – codziennie o 9:00 (powiadomienie in-app)
    try {
      const { startNewOrdersDigestCron } = require('./jobs/newOrdersDigestForProviders');
      startNewOrdersDigestCron();
    } catch (e) {
      logger.error('[CRON] Error scheduling newOrdersDigestForProviders:', e);
    }
  } else {
    logger.info('[CRON] Jobs disabled (ENABLE_JOBS != 1). Skipping cron scheduling.');
  }

  logger.info('Server should be running now...');
}

// CRON – reset darmowych ekspresów codziennie o 03:00
try {
  if (process.env.VERCEL !== '1' && ENABLE_JOBS) {
    // Subscription Email Marketing - codziennie o 10:00
  try {
    const { runSubscriptionEmailMarketing } = require('./jobs/subscriptionEmailMarketing');
    cron.schedule('0 10 * * *', async () => {
      try {
        await runSubscriptionEmailMarketing();
        logger.info('[CRON] Subscription email marketing sent');
      } catch (e) {
        logger.error('[CRON] Error in subscription email marketing:', e);
      }
    });
    logger.info('[CRON] Subscription email marketing scheduled');
  } catch (e) {
    logger.error('[CRON] Error scheduling subscription email marketing:', e);
  }

  // Subscription Push Notifications - codziennie o 11:00
  try {
    const { runSubscriptionPushNotifications } = require('./jobs/subscriptionPushNotifications');
    cron.schedule('0 11 * * *', async () => {
      try {
        await runSubscriptionPushNotifications();
        logger.info('[CRON] Subscription push notifications sent');
      } catch (e) {
        logger.error('[CRON] Error in subscription push notifications:', e);
      }
    });
    logger.info('[CRON] Subscription push notifications scheduled');
  } catch (e) {
    logger.error('[CRON] Error scheduling subscription push notifications:', e);
  }

  cron.schedule('0 3 * * *', async () => {
      try { 
        await resetMonthlyExpress(); 
        logger.info('[CRON] resetMonthlyExpress done'); 
      }
      catch(e){ 
        logger.error('[CRON] resetMonthlyExpress error', e); 
      }
    });
  }
} catch {}

// Eksporty dla środowisk serverless (Vercel)
module.exports = app;module.exports.connectMongo = connectMongo;
