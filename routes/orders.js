// backend/routes/orders.js
const express = require("express");
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const { requireKycVerified } = require("../middleware/kyc");
const Order = require("../models/Order");
const User = require("../models/User");
const Service = require("../models/Service");
const Revenue = require("../models/Revenue");
const NotificationService = require("../services/NotificationService");
const Payment = require("../models/Payment");
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Post-Order Agent (lazy load dla optymalizacji)
let runPostOrderAgent = null;
function getPostOrderAgent() {
  if (!runPostOrderAgent) {
    try {
      const postOrderModule = require("../ai/agents/postOrderAgent");
      runPostOrderAgent = postOrderModule.runPostOrderAgent;
    } catch (error) {
      console.warn('Post-Order Agent not available:', error.message);
      return null;
    }
  }
  return runPostOrderAgent;
}

// Konfiguracja multer dla uploadu plików zleceń
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'orders');
    // Sprawdź czy katalog istnieje, jeśli nie - utwórz go
    const fs = require('fs');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const safe = 'order-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
    cb(null, safe);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];

    const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf', '.doc', '.docx', '.xls', '.xlsx']);
    const ext = path.extname(file.originalname || '').toLowerCase();
    const isAllowedMime = allowedMimeTypes.includes(file.mimetype);
    const isAllowedExt = allowedExtensions.has(ext);

    console.log('UPLOAD DEBUG:', {
      route: req.originalUrl || req.url,
      originalname: file.originalname,
      mimetype: file.mimetype,
      ext
    });

    // Primary rule: trusted MIME type. Fallback rule: known extension.
    if (isAllowedMime || isAllowedExt) {
      return cb(null, true);
    }

    console.error('UPLOAD REJECTED:', {
      route: req.originalUrl || req.url,
      originalname: file.originalname,
      mimetype: file.mimetype,
      ext
    });
    cb(new Error('Tylko obrazy i dokumenty są dozwolone!'));
  }
});

const withServerOrigin = (relativePath) => {
  const base = (process.env.SERVER_URL || '').trim().replace(/\/$/, '');
  if (!base) return relativePath;
  if (!/^https?:\/\//i.test(base)) return relativePath;
  return `${base}${relativePath}`;
};
const toPublicUrl = (filename) => withServerOrigin(`/uploads/orders/${filename}`);
const toInvoiceUrl = (filename) => withServerOrigin(`/uploads/orders/invoices/${filename}`);
const fs = require('fs');
const mongoose = require('mongoose');

/** Ścieżka absolutna do pliku załącznika (tylko podkatalog `orders/`, ochrona przed path traversal). */
function resolveOrderAttachmentDiskPath(storedUrl) {
  if (!storedUrl || typeof storedUrl !== 'string') return null;
  let pathname = storedUrl.trim();
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch (_e) {
    return null;
  }
  const basename = path.basename(pathname);
  if (!basename || basename === '.' || basename === '..') return null;
  const ordersDir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'orders');
  const fullPath = path.join(ordersDir, basename);
  const resolved = path.resolve(fullPath);
  const ordersResolved = path.resolve(ordersDir);
  if (!resolved.startsWith(ordersResolved + path.sep) && resolved !== ordersResolved) return null;
  return resolved;
}

/** Porównanie zapisanych URL-i załącznika (względny vs pełny z SERVER_URL). */
function attachmentStoredUrlsMatch(a, b) {
  if (!a || !b) return false;
  const s1 = String(a).trim();
  const s2 = String(b).trim();
  if (s1 === s2) return true;
  const pathname = (s) => {
    try {
      if (/^https?:\/\//i.test(s)) return new URL(s).pathname || s;
    } catch (_e) {
      /* ignore */
    }
    return s.startsWith('/') ? s : `/${s}`;
  };
  return pathname(s1) === pathname(s2);
}

// Multer dla faktur (tylko PDF)
const invoiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'orders', 'invoices');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `invoice-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const uploadInvoice = multer({
  storage: invoiceStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit dla faktur
  fileFilter: (req, file, cb) => {
    // Akceptuj tylko PDF
    const allowedTypes = /pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype === 'application/pdf';
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Faktura musi być w formacie PDF!'));
    }
  }
});

// Funkcja pomocnicza do obliczania czasu wygaśnięcia zlecenia na podstawie urgency
// Pilność → czas do wygaśnięcia: now=6h, today=24h, tomorrow=48h, this_week=7dni, flexible=72h
function calculateOrderExpiration(urgency) {
  const now = new Date();
  let expirationHours = 72; // Domyślnie 3 dni

  switch (urgency) {
    case 'now':
      expirationHours = 6; // 6 godzin dla pilnych "teraz"
      break;
    case 'today':
      expirationHours = 24; // 24 godziny dla "dziś"
      break;
    case 'tomorrow':
      expirationHours = 48; // 48 godzin dla "jutro"
      break;
    case 'this_week':
      expirationHours = 168; // 7 dni dla "w tym tygodniu"
      break;
    case 'flexible':
    default:
      expirationHours = 72; // 3 dni dla elastycznych
      break;
  }

  return new Date(now.getTime() + expirationHours * 60 * 60 * 1000);
}

// Po wygaśnięciu zlecenia: jeszcze przez tyle godzin pokazujemy je wykonawcom (status "wygasło", klient może wznowić).
// Po tym czasie, jeśli klient nie wznowi (nie wydłuży), zlecenie znika z listy GET /api/orders/open.
const EXPIRED_HIDDEN_AFTER_HOURS = 24;

// Fallback dla starych zleceń bez expiresAt: wylicz na podstawie createdAt
function calculateOrderExpirationFrom(urgency, baseDate) {
  const base = baseDate instanceof Date && !isNaN(baseDate) ? baseDate : new Date();
  let expirationHours = 72;
  switch (urgency) {
    case 'now':
      expirationHours = 6;
      break;
    case 'today':
      expirationHours = 24;
      break;
    case 'tomorrow':
      expirationHours = 48;
      break;
    case 'this_week':
      expirationHours = 168;
      break;
    case 'flexible':
    default:
      expirationHours = 72;
      break;
  }
  return new Date(base.getTime() + expirationHours * 60 * 60 * 1000);
}

// POST /api/orders/temp-upload - tymczasowy upload plików (przed utworzeniem zlecenia)
router.post('/temp-upload', auth, (req, res, next) => {
  upload.array('files', 5)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'Plik jest za duży (max 10MB).' });
      }
      return res.status(400).json({ message: `Błąd uploadu: ${err.message}` });
    }
    return res.status(400).json({ message: err.message || 'Błąd uploadu plików' });
  });
}, async (req, res) => {
  try {
    // Dodaj nowe pliki
    const newAttachments = (req.files || []).map(file => ({
      url: toPublicUrl(file.filename),
      mimeType: file.mimetype,
      filename: file.originalname,
      size: file.size
    }));
    
    res.json({ 
      message: 'Pliki zostały przesłane',
      attachments: newAttachments
    });
  } catch (error) {
    console.error('Temp upload error:', error);
    res.status(500).json({ message: 'Błąd uploadu plików' });
  }
});

router.post("/quote-draft", auth, async (req, res) => {
  try {
    const { providerId } = req.body;
    let { serviceId } = req.body;

    if (!providerId) {
      return res.status(400).json({ error: "providerId jest wymagany" });
    }

    // === Jeśli nie podano serviceId → spróbuj ustalić domyślną usługę providera ===
    if (!serviceId) {
      const provider = await User.findById(providerId).lean();
      // A) provider ma przypięte usługi (ObjectId do Service)
      if (provider?.services?.length) {
        serviceId = String(provider.services[0]);
      } else {
        // B) Spróbuj dopasować po nazwie (np. provider.serviceType)
        const byName = (provider?.serviceType || provider?.service || "").trim();
        if (byName) {
          const found = await Service.findOne({ name: new RegExp(`^${byName}$`, "i") }).lean();
          if (found?._id) serviceId = String(found._id);
        }
        // C) Ostateczny fallback: weź pierwszą dostępną usługę
        if (!serviceId) {
          const anyService = await Service.findOne({}).lean();
          if (anyService?._id) serviceId = String(anyService._id);
        }
      }
    }

    if (!serviceId) {
      return res.status(400).json({ error: "Brak przypisanej usługi do wyceny dla tego wykonawcy." });
    }

    // znajdź istniejący draft
    let order = await Order.findOne({
      client: req.user._id,
      provider: providerId,
      service: serviceId,
      status: "quote",
    });

    let created = false;
    if (!order) {
      order = await Order.create({
        client: req.user._id,
        provider: providerId,
        service: serviceId,
        description: "",
        location: null,
        status: "quote",
        createdAt: new Date(),
      });
      created = true;
    }

    res.json({ orderId: order._id, created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Nie udało się utworzyć/pobrać draftu" });
  }
});

// Tworzenie nowego zlecenia (obsługa Fast-Track limitów)
const { ensureClientCanFastTrack, consumeClientFastTrack } = require("../middleware/limits");

router.post("/", auth, async (req, res) => {
  try {
    const logger = require("../utils/logger");
    
    // Sprawdź czy user jest client
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: "Tylko klienci mogą tworzyć zlecenia" });
    }
    
    const {
      service, 
      description, 
      location, 
      status = "open", 
      type = "open",
      providerId,
      budget, // Legacy
      budgetRange, // MVP: nowe pole {min, max}
      urgency, // MVP: 'now' | 'today' | 'flexible'
      preferredContact, // MVP: 'chat' | 'call'
      contactPreference, // Legacy
      locationLat,
      locationLon,
      attachments,
      priority = "normal",
      priorityFee = 0,
      priorityDateTime = null,
      matchMode = "open", // MVP: 'ai_suggested' | 'manual_pick' | 'open'
      aiTriage, // MVP: cache AI triage result
      paymentPreference = "system", // MVP: 'system' | 'external'
      paymentMethod = "system" // Legacy: 'system' | 'external'
    } = req.body;

    // Attachments can arrive as JSON string or objects array.
    // Normalize to a safe structure before validation/create.
    let normalizedAttachments = [];
    if (attachments) {
      let parsed = attachments;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch (_e) {
          parsed = [];
        }
      }
      const list = Array.isArray(parsed) ? parsed : [];
      normalizedAttachments = list
        .map((att) => {
          if (!att) return null;
          if (typeof att === 'string') return { url: att };
          if (typeof att === 'object') {
            const url = typeof att.url === 'string' ? att.url : '';
            if (!url) return null;
            return {
              url,
              mimeType:
                typeof att.mimeType === 'string'
                  ? att.mimeType
                  : (typeof att.type === 'string' ? att.type : ''),
              filename: typeof att.filename === 'string' ? att.filename : '',
              size: Number(att.size) || 0
            };
          }
          return null;
        })
        .filter(Boolean);
    }

    // Walidacja wymaganych pól
    if (!service || !description) {
      return res.status(400).json({ error: "Usługa i opis są wymagane" });
    }
    
    // Normalizacja: użyj nowych pól jeśli dostępne
    const finalUrgency = urgency || 'flexible';
    const finalPreferredContact = preferredContact || contactPreference || 'chat';
    const finalBudgetRange = budgetRange || (budget ? { min: budget * 0.8, max: budget * 1.2 } : null);

    // Sprawdź czy klient ma pakiet, który obejmuje priorytet (Fast-Track)
    let finalPriorityFee = priorityFee;
    if (priority === "priority") {
      // Sprawdź subskrypcję klienta
      const UserSubscription = require('../models/UserSubscription');
      const SubscriptionPlan = require('../models/SubscriptionPlan');
      const subscription = await UserSubscription.findOne({ 
        user: req.user._id,
        validUntil: { $gt: new Date() }
      });
      
      const packageType = subscription?.planKey || 'CLIENT_FREE';
      const isPro = packageType === 'CLIENT_PRO';
      const isBusinessPlan = subscription?.isBusinessPlan || false;
      const useCompanyPool = subscription?.useCompanyResourcePool || false;
      
      // Sprawdź najpierw resource pool firmy (jeśli użytkownik należy do firmy i ma business plan)
      if (isBusinessPlan && useCompanyPool && req.user.company) {
        const { canUseCompanyResource } = require('../utils/resourcePool');
        const check = await canUseCompanyResource(req.user._id, 'fastTrack', 1);
        
        if (check.allowed) {
          // Może użyć Fast-Track z puli firmowej - fee = 0
          finalPriorityFee = 0;
          // UWAGA: zasób zostanie wykorzystany w checkout.js przy finalizacji płatności
        } else {
          // Nie może użyć z puli firmowej - sprawdź indywidualne limity
          if (isPro) {
            finalPriorityFee = 0;
          } else if (packageType === 'CLIENT_STD' && subscription?.freeExpressLeft > 0) {
            finalPriorityFee = 0;
          } else {
            finalPriorityFee = 1000; // 10 zł
          }
        }
      } else {
        // Standardowa logika dla indywidualnych użytkowników
        if (isPro) {
          // PRO ma nielimitowany Fast-Track
          finalPriorityFee = 0;
        } else if (packageType === 'CLIENT_STD' && subscription?.freeExpressLeft > 0) {
          // STANDARD ma 3x Fast-Track/mies. - użyj darmowego jeśli dostępny
          finalPriorityFee = 0;
          // UWAGA: freeExpressLeft zostanie odjęte w checkout.js przy finalizacji płatności
        } else {
          // FREE lub STANDARD bez darmowych Fast-Track = 10 zł
          finalPriorityFee = 1000; // 10 zł w groszach (1000 groszy)
        }
      }
    }

    // Przygotuj location object dla geo search i dla schemy (Order.location to obiekt { lat, lng, address })
    let locationObj = null;
    if (locationLat && locationLon) {
      locationObj = {
        lat: locationLat,
        lng: locationLon,
        // Jeśli user kliknął GPS, ale nie wpisał adresu (location=""),
        // UI ma pokazywać przynajmniej fallback zamiast "Nie podano".
        address: location || "Do ustalenia"
      };
    } else if (location && typeof location === 'object' && location.lat && location.lng) {
      locationObj = location;
    } else if (location && typeof location === 'string') {
      locationObj = { address: location };
    }

    // Dodatkowy safety: jeśli z jakiegoś powodu address jest null/undefined,
    // ustaw fallback.
    if (locationObj && (!locationObj.address || typeof locationObj.address !== 'string')) {
      locationObj = { ...locationObj, address: location || "Do ustalenia" };
    }
    
    // Określ początkowy status
    let initialStatus = status;
    if (matchMode === 'open' && initialStatus === 'open') {
      initialStatus = 'collecting_offers'; // MVP: automatycznie przejdź do zbierania ofert
    }
    
    // Oblicz czas wygaśnięcia na podstawie urgency
    const expiresAt = calculateOrderExpiration(finalUrgency);
    
    const order = await Order.create({
      client: req.user._id,
      ...(providerId ? { provider: providerId } : {}),
      service,
      description,
      // Schema `Order.location` jest obiektem { lat, lng, address }.
      // Nawet gdy użytkownik nie podał GPS, zapisujemy address jako location.address.
      location: locationObj || { address: location || "Do ustalenia" },
      // MVP Fields
      urgency: finalUrgency,
      budgetRange: finalBudgetRange,
      preferredContact: finalPreferredContact,
      matchMode: matchMode,
      aiTriage: aiTriage || null,
      // Payment preferences (paymentPreference = flow: system vs external; paymentMethod = konkretna metoda Stripe, domyślnie unknown)
      paymentPreference: paymentPreference || 'system', // 'system' | 'external'
      // paymentMethod w schemie Order to enum ['card','p24','blik','unknown'] – nie ustawiać na 'system'/'external'
      // Location (geo)
      ...(locationObj && {
        locationLat: locationObj.lat,
        locationLon: locationObj.lng
      }),
      // Status
      status: initialStatus,
      type,
      priority,
      priorityFee: finalPriorityFee,
      priorityDateTime,
      // System wygasania
      expiresAt: expiresAt,
      originalExpiresAt: expiresAt,
      // Legacy fields (kompatybilność wsteczna)
      ...(budget && { budget }),
      ...(req.body.urgencyTime && { urgencyTime: req.body.urgencyTime }),
      ...(contactPreference && { contactPreference }),
      ...(normalizedAttachments.length > 0 && { attachments: normalizedAttachments }),
      createdAt: new Date(),
    });
    
    // Automatyczne przypisanie zlecenia dla firm B2B
    try {
      const User = require('../models/User');
      const client = await User.findById(req.user._id).populate('company');
      
      if (client && client.company && !providerId) {
        // Sprawdź czy klient należy do firmy i czy firma ma włączony workflow
        const { autoAssignOrder } = require('../utils/workflowRouter');
        const assignmentResult = await autoAssignOrder(client.company._id, order._id);
        
        if (assignmentResult.success) {
          // Zaktualizuj order z przypisanym providerem
          order.provider = assignmentResult.provider._id;
          order.assignedAt = new Date();
          order.assignedBy = 'workflow_automation';
          await order.save();
          
          // Wyślij powiadomienie do przypisanego providera
          try {
            const NotificationService = require('../services/NotificationService');
            await NotificationService.sendNotification(assignmentResult.provider._id, {
              type: 'order_assigned',
              title: 'Nowe zlecenie przypisane',
              message: `Zostałeś automatycznie przypisany do zlecenia: ${order.description?.substring(0, 50) || 'Nowe zlecenie'}`,
              link: `/orders/${order._id}`
            });
          } catch (notifError) {
            console.error('Error sending assignment notification:', notifError);
          }
        }
      }
    } catch (workflowError) {
      // Nie przerywaj tworzenia zlecenia jeśli workflow nie działa
      console.error('Error in workflow automation:', workflowError);
    }
    
    // Zapisz użycie w UsageAnalytics
    try {
      const UsageAnalytics = require('../models/UsageAnalytics');
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await UsageAnalytics.incrementUsage(req.user._id, monthKey, 'ordersCreated', 1, false);
      
      // Jeśli Fast-Track - zapisz użycie
      if (priority === 'priority') {
        const isPaid = finalPriorityFee > 0;
        await UsageAnalytics.incrementUsage(req.user._id, monthKey, 'fastTrackUsed', 1, isPaid);
        if (!isPaid) {
          // Użycie darmowego Fast-Track
          const sub = await UserSubscription.findOne({ user: req.user._id, validUntil: { $gt: now } });
          if (sub && sub.freeExpressLeft > 0) {
            // To zostanie odjęte w checkout.js
          }
        }
      }
    } catch (analyticsError) {
      console.error('Error saving order usage analytics:', analyticsError);
    }
    
    // Aktualizuj lastActivity dla email marketing
    await User.findByIdAndUpdate(req.user._id, {
      'emailMarketing.lastActivity': new Date()
    });
    
    // Gamification: sprawdź badges po utworzeniu zlecenia
    try {
      const { checkOrderBadges } = require('../utils/gamification');
      await checkOrderBadges(req.user._id);
    } catch (gamificationError) {
      console.error('Error checking order badges:', gamificationError);
    }

    // Rejestruj przychód z dopłaty za priorytet
    if (priority === "priority" && finalPriorityFee > 0) {
      await Revenue.create({
        orderId: order._id,
        clientId: req.user._id,
        type: "priority_fee",
        amount: finalPriorityFee,
        description: `Dopłata za priorytetowe zlecenie - ${service}`,
        status: "pending", // będzie zmienione na "paid" po płatności
        metadata: {
          priorityFee: finalPriorityFee,
          package: req.user.level || "standard",
          tier: req.user.providerTier || "basic"
        }
      });
    }

    // Jeśli zlecenie jest bezpośrednie do konkretnego wykonawcy → wyślij wiadomość powitalną i powiadomienie
    try {
      if (providerId) {
        const Message = require('../models/Message');
        await Message.create({
          from: req.user._id,
          to: providerId,
          orderId: order._id,
          text: 'Dzień dobry, proszę o akceptację i wstępną wycenę.'
        });
        
        // Wyślij powiadomienie do providera o nowym bezpośrednim zleceniu
        try {
          await NotificationService.notifyNewDirectOrder(order._id, providerId, req.user._id);
        } catch (notifError) {
          console.warn('Notification failed:', notifError?.message || notifError);
        }
      }
    } catch (e) {
      console.warn('Auto-message failed:', e?.message || e);
    }

    res.status(201).json({
      orderId: order._id,
      _id: order._id,
      message: "Zlecenie zostało utworzone.",
      priorityFee: priority === "priority" ? finalPriorityFee : 0,
    });
  } catch (e) {
    const logger = require("../utils/logger");
    logger.error("CREATE_ORDER_ERROR:", {
      message: e.message,
      stack: e.stack,
      userId: req.user?._id,
      service: req.body?.service
    });
    const isDev = process.env.NODE_ENV !== 'production';
    res.status(500).json({
      error: "Nie udało się utworzyć zlecenia",
      ...(isDev && { detail: e.message })
    });
  }
});

// GET /api/orders/open - lista otwartych zleceń (popyt dla usługodawców)
// WAŻNE: Ten endpoint MUSI być przed router.get('/:id'), żeby nie był przechwytywany
router.get('/open', auth, async (req, res) => {
  try {
    console.log('✅ GET /api/orders/open - endpoint wywołany');
    console.log('✅ User:', req.user?._id, req.user?.email, req.user?.role);
    
    const { service, urgency, maxDistance, lat, lng, budgetMin, budgetMax, services, companyId, serviceKind } = req.query;
    
    // Debug log
    console.log('🔍 GET_OPEN_ORDERS:', { 
      service, 
      urgency, 
      maxDistance, 
      lat, 
      lng, 
      budgetMin, 
      budgetMax, 
      services,
      companyId,
      servicesType: typeof services,
      servicesIsArray: Array.isArray(services)
    });
    
    // Sprawdź czy użytkownik jest w firmie i czy chce widzieć zlecenia dla całej firmy
    const user = await User.findById(req.user._id).populate('company');
    const isInCompany = user?.company && (user.roleInCompany === 'owner' || user.roleInCompany === 'manager');
    const showCompanyOrders = companyId || (isInCompany && req.query.showCompany === 'true');
    const filterProviderId = req.query.providerId; // Filtr po konkretnym providerze z firmy
    
    // Podstawowe filtrowanie - tylko otwarte zlecenia (open lub collecting_offers)
    let query = { status: { $in: ['open', 'collecting_offers'] } };
    
    // Jeśli pokazujemy zlecenia dla firmy, pobierz wszystkich wykonawców z firmy
    let companyProviderIds = null;
    if (showCompanyOrders && user?.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(user.company._id || user.company).populate('providers');
      if (company) {
        // Pobierz wszystkich providerów z firmy (włącznie z ownerem jeśli jest providerem)
        const companyUsers = await User.find({
          $or: [
            { company: company._id },
            { _id: company.owner }
          ],
          role: { $in: ['provider', 'company_owner'] }
        }).select('_id');
        companyProviderIds = companyUsers.map(u => u._id);
        console.log('🏢 Company providers:', companyProviderIds.length);
        
        // Jeśli wybrano konkretnego providera, filtruj tylko jego zlecenia
        if (filterProviderId && filterProviderId !== 'any') {
          // Sprawdź czy provider należy do firmy
          const providerBelongsToCompany = companyProviderIds.some(id => String(id) === String(filterProviderId));
          if (providerBelongsToCompany) {
            companyProviderIds = [filterProviderId];
            console.log('🔍 Filtering by provider:', filterProviderId);
          }
        }
      }
    }
    
    // Filtry opcjonalne
    if (service && service !== 'any') {
      query.service = service;
    }
    
    // Filtrowanie po usługach (array)
    if (services) {
      let serviceArray;
      if (Array.isArray(services)) {
        // services jest już tablicą - sprawdź czy to ObjectIds czy stringi
        serviceArray = services.map(s => {
          if (typeof s === 'object' && s._id) {
            return s._id; // ObjectId z populate
          } else if (typeof s === 'string') {
            return s; // String ID
          } else {
            return String(s); // Fallback
          }
        });
      } else if (typeof services === 'string') {
        // services jest stringiem - podziel po przecinkach
        serviceArray = services.split(',').map(s => s.trim());
      } else {
        // fallback
        serviceArray = [String(services)];
      }
      // Dopasowanie: slug z konta może być kategorią (np. hydraulika) a zlecenie — pełnym slugiem (hydraulika-naprawa-…)
      const escapeRegex = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (serviceArray.length > 0) {
        query.$or = serviceArray.map((s) => {
          const part = escapeRegex(String(s)).replace(/_/g, '[-_]');
          return { service: { $regex: new RegExp(`^${part}(-|$)`, 'i') } };
        });
      }
    }
    
    if (urgency && urgency !== 'any') {
      query.urgency = urgency;
    }
    
    if (budgetMin || budgetMax) {
      query.budget = {};
      if (budgetMin) query.budget.$gte = Number(budgetMin);
      if (budgetMax) query.budget.$lte = Number(budgetMax);
    }
    
    // Filtrowanie po service_kind (onsite, remote, hybrid)
    if (serviceKind && ['onsite', 'remote', 'hybrid'].includes(serviceKind)) {
      try {
        const Service = require('../models/Service');
        // Znajdź wszystkie usługi z danym service_kind
        const servicesWithKind = await Service.find({ service_kind: serviceKind })
          .select('slug')
          .lean();
        
        if (servicesWithKind.length > 0) {
          const serviceSlugs = servicesWithKind.map(s => s.slug);
          // Dodaj filtr po slugach usług
          if (query.$or) {
            // Jeśli już jest $or, połącz z nowym filtrem
            query.$and = [
              { $or: query.$or },
              { service: { $in: serviceSlugs } }
            ];
            delete query.$or;
          } else if (query.service) {
            // Jeśli już jest filtr po service, sprawdź czy pasuje do serviceKind
            // Jeśli nie pasuje, zwróć pusty wynik
            if (typeof query.service === 'string' && !serviceSlugs.includes(query.service)) {
              // Service nie pasuje do serviceKind - zwróć pusty wynik
              query._id = { $in: [] }; // Force empty result
            } else if (typeof query.service === 'object' && query.service.$in) {
              // Filtruj tylko te które są w serviceSlugs
              query.service.$in = query.service.$in.filter(s => serviceSlugs.includes(s));
              if (query.service.$in.length === 0) {
                query._id = { $in: [] }; // Force empty result
              }
            }
          } else {
            // Nowy filtr po serviceKind
            query.service = { $in: serviceSlugs };
          }
        } else {
          // Brak usług z danym service_kind - zwróć pusty wynik
          query._id = { $in: [] };
        }
      } catch (error) {
        console.error('Error filtering by serviceKind:', error);
        // W przypadku błędu, kontynuuj bez filtrowania po serviceKind
      }
    }
    
    // Jeśli pokazujemy zlecenia dla firmy, rozszerz filtrowanie po usługach
    if (companyProviderIds && companyProviderIds.length > 0) {
      // Pobierz wszystkie usługi wykonawców z firmy
      const companyProviders = await User.find({ _id: { $in: companyProviderIds } })
        .populate('services')
        .select('services');
      
      const allCompanyServices = [];
      companyProviders.forEach(provider => {
        if (provider.services && Array.isArray(provider.services)) {
          provider.services.forEach(service => {
            const serviceId = service._id || service;
            if (!allCompanyServices.includes(String(serviceId))) {
              allCompanyServices.push(String(serviceId));
            }
          });
        }
      });
      
      // Jeśli są usługi w firmie, rozszerz query
      if (allCompanyServices.length > 0) {
        if (query.service && typeof query.service === 'object' && query.service.$in) {
          // Połącz istniejące filtry z usługami firmy
          query.service.$in = [...new Set([...query.service.$in, ...allCompanyServices])];
        } else if (!query.service) {
          // Jeśli nie ma filtra po usłudze, użyj wszystkich usług firmy
          query.service = { $in: allCompanyServices };
        }
      }
    }
    
    // Ukryj zlecenia od kont seed/test (@helpfli.test, @*.local) przed prawdziwymi użytkownikami
    const { shouldFilterDemoData, getDemoUserIds } = require('../utils/demoAccounts');
    if (shouldFilterDemoData(req.user)) {
      const demoIds = await getDemoUserIds();
      if (demoIds.length) {
        query = { $and: [query, { client: { $nin: demoIds } }] };
      }
    }

    // Pobierz zlecenia
    console.log('🔍 GET_OPEN_ORDERS: Query:', JSON.stringify(query, null, 2));
    let orders = await Order.find(query)
      .populate('client', 'name email phone level providerLevel')
      .sort({ 
        createdAt: -1 
      })
      .limit(50);
    
    // Pobierz liczbę ofert dla każdego zlecenia
    const Offer = require('../models/Offer');
    const orderIds = orders.map(o => o._id);
    const offersCounts = await Offer.aggregate([
      { $match: { orderId: { $in: orderIds }, status: { $in: ['sent', 'accepted'] } } },
      { $group: { _id: '$orderId', count: { $sum: 1 } } }
    ]);
    const offersCountMap = new Map(offersCounts.map(item => [String(item._id), item.count]));
    
    console.log('🔍 GET_OPEN_ORDERS: Found orders before filtering:', orders.length);
    
    // Sortuj ręcznie: najpierw podbite, potem pilne, potem normalne
    const sortNow = new Date();
    orders.sort((a, b) => {
      // 1. Podbite zlecenia (boostedUntil > now) - najwyższy priorytet
      const aBoosted = a.boostedUntil && new Date(a.boostedUntil) > sortNow;
      const bBoosted = b.boostedUntil && new Date(b.boostedUntil) > sortNow;
      if (aBoosted && !bBoosted) return -1;
      if (!aBoosted && bBoosted) return 1;
      if (aBoosted && bBoosted) {
        // Oba podbite - sortuj po boostedUntil DESC
        return new Date(b.boostedUntil) - new Date(a.boostedUntil);
      }
      
      // 2. Pilne zlecenia (priority === 'priority')
      const aIsPilne = a.priority === 'priority';
      const bIsPilne = b.priority === 'priority';
      if (aIsPilne && !bIsPilne) return -1;
      if (!aIsPilne && bIsPilne) return 1;
      
      // 3. Normalne zlecenia - sortuj po createdAt DESC
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    
    // Filtrowanie po dystansie (jeśli podano koordynaty)
    if (lat && lng && maxDistance) {
      const userLat = Number(lat);
      const userLng = Number(lng);
      const maxDist = Number(maxDistance);
      
      console.log('🔍 GET_OPEN_ORDERS: Filtering by distance:', { userLat, userLng, maxDist });
      
      const beforeFilter = orders.length;
      // Filtruj tylko zlecenia z koordynatami - zlecenia bez koordynatów pokaż zawsze
      orders = orders.filter(order => {
        if (!order.locationLat || !order.locationLon) {
          // Zlecenia bez koordynatów pokaż zawsze (nie filtruj po dystansie)
          return true;
        }
        
        const distance = calculateDistance(
          userLat, userLng,
          order.locationLat, order.locationLon
        );
        
        return distance <= maxDist;
      });
      
      console.log('🔍 GET_OPEN_ORDERS: After distance filter:', { before: beforeFilter, after: orders.length });
      
      // Dodaj informację o dystansie
      orders = orders.map(order => {
        const orderObj = order.toObject();
        if (order.locationLat && order.locationLon) {
          orderObj.distanceKm = calculateDistance(
          userLat, userLng,
          order.locationLat, order.locationLon
          );
        } else {
          orderObj.distanceKm = null; // Nieznany dystans
        }
        return orderObj;
      });
    } else {
      // Jeśli nie ma filtrowania po dystansie, dodaj distanceKm = null dla wszystkich
      orders = orders.map(order => ({
        ...order.toObject(),
        distanceKm: null
      }));
    }
    
    // Przekształć na format dla frontendu
    const now = new Date();
    const demand = orders.map(order => {
      // Sprawdź status wygaśnięcia
      let expiresAt = order.expiresAt ? new Date(order.expiresAt) : null;
      // Stare zlecenia (np. z seedów) mogły nie mieć expiresAt – wylicz fallback z createdAt
      if (!expiresAt) {
        const createdBase = order.createdAt ? new Date(order.createdAt) : null;
        if (createdBase && !isNaN(createdBase)) {
          expiresAt = calculateOrderExpirationFrom(order.urgency || 'flexible', createdBase);
        }
      }
      const isExpired = expiresAt ? expiresAt < now : false;
      const timeUntilExpiry = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000 / 60)) : null; // w minutach
      const hoursUntilExpiry = timeUntilExpiry !== null ? Math.floor(timeUntilExpiry / 60) : null;
      const minutesUntilExpiry = timeUntilExpiry !== null ? timeUntilExpiry % 60 : null;
      
      const baseData = {
        _id: order._id,
        service: order.service,
        serviceDetails: order.serviceDetails,
        urgency: order.urgency || 'flexible',
        locationLat: order.locationLat,
        locationLon: order.locationLon,
        distanceKm: order.distanceKm || 0,
        createdAt: order.createdAt,
        priority: order.priority || 'normal',
        priorityFee: order.priorityFee || 0,
        paymentMethod: order.paymentMethod || 'system', // Typ płatności
        offersCount: offersCountMap.get(String(order._id)) || 0, // Liczba ofert
        // Informacje o wygaśnięciu
        expiresAt: expiresAt,
        isExpired: isExpired,
        timeUntilExpiry: timeUntilExpiry,
        hoursUntilExpiry: hoursUntilExpiry,
        minutesUntilExpiry: minutesUntilExpiry,
        extendedCount: order.extendedCount || 0,
        autoExtended: order.autoExtended || false,
        // Załączniki (zdjęcia/filmy)
        attachments: order.attachments || [],
        // Źródło zlecenia (AI vs manual)
        source: order.source || 'manual'
      };

      // Dla Fast-Track zleceń - pokaż pełne szczegóły + oznaczenie
      if (order.priority === 'priority') {
        return {
          ...baseData,
          description: order.description, // Pokaż pełny opis!
          location: order.location, // Pokaż pełną lokalizację!
          budget: order.budget,
          budgetRange: order.budgetRange || (order.budget ? { min: order.budget * 0.8, max: order.budget * 1.2 } : null),
          client: order.client, // Pokaż dane klienta!
          paymentMethod: order.paymentMethod || 'system', // Typ płatności
          paymentPreference: order.paymentPreference || 'system', // Preferencje klienta
          isPriority: true,
          isFastTrack: true, // Nowe pole dla Fast-Track
          priorityDateTime: order.priorityDateTime,
          priorityInfo: {
            fee: order.priorityFee,
            message: '⚡ Pilne: To zlecenie ma priorytet. Zalecamy dodać 10% więcej za szybką reakcję.',
            requestedDateTime: order.priorityDateTime ? new Date(order.priorityDateTime).toLocaleString('pl-PL') : null
          }
        };
      }

      // Dla normalnych zleceń - pokaż wszystkie dane
      return {
        ...baseData,
        description: order.description,
        location: order.location,
        budget: order.budget,
        budgetRange: order.budgetRange || (order.budget ? { min: order.budget * 0.8, max: order.budget * 1.2 } : null),
        client: order.client,
        paymentMethod: order.paymentMethod || 'system', // Typ płatności
        paymentPreference: order.paymentPreference || 'both', // Preferencje klienta
        isPriority: false,
        isFastTrack: false,
        isPilne: false
      };
    });

    // Ukryj u wykonawcy zlecenia wygasłe dawniej niż EXPIRED_HIDDEN_AFTER_HOURS (klient mógł wznowić; jak nie wznowi – znika z Provider Home)
    const expiredHiddenAfterMs = EXPIRED_HIDDEN_AFTER_HOURS * 60 * 60 * 1000;
    const visibleToProvider = demand.filter((o) => {
      if (!o.isExpired) return true;
      const expiredAt = o.expiresAt ? new Date(o.expiresAt).getTime() : 0;
      const expiredAgo = now.getTime() - expiredAt;
      return expiredAgo <= expiredHiddenAfterMs;
    });

    console.log('🔍 GET_OPEN_ORDERS: Returning orders:', visibleToProvider.length, '(hidden expired:', demand.length - visibleToProvider.length, ')');
    res.json({ orders: visibleToProvider });
  } catch (err) {
    console.error('GET_OPEN_ORDERS_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania zleceń' });
  }
});

// GET /api/orders/my/stats - MUSI być przed GET /:id
router.get('/my/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    const stats = { client: {}, provider: {} };
    const clientOrders = await Order.find({ client: userId });
    stats.client = {
      total: clientOrders.length,
      open: clientOrders.filter(o => o.status === 'open' || o.status === 'collecting_offers').length,
      collectingOffers: clientOrders.filter(o => o.status === 'collecting_offers').length,
      accepted: clientOrders.filter(o => o.status === 'accepted').length,
      paid: clientOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem || o.status === 'funded').length,
      inProgress: clientOrders.filter(o => o.status === 'in_progress').length,
      completed: clientOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
      cancelled: clientOrders.filter(o => o.status === 'cancelled').length,
      disputed: clientOrders.filter(o => o.disputeStatus && o.disputeStatus !== 'none').length,
      totalSpent: clientOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem).reduce((sum, o) => sum + (o.amountTotal || o.pricing?.total || 0), 0)
    };
    const providerOrders = await Order.find({ provider: userId });
    stats.provider = {
      total: providerOrders.length,
      pendingOffers: 0,
      accepted: providerOrders.filter(o => o.status === 'accepted').length,
      paid: providerOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem || o.status === 'funded').length,
      inProgress: providerOrders.filter(o => o.status === 'in_progress').length,
      completed: providerOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
      released: providerOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).length,
      cancelled: providerOrders.filter(o => o.status === 'cancelled').length,
      disputed: providerOrders.filter(o => o.disputeStatus && o.disputeStatus !== 'none').length,
      totalEarnings: providerOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).reduce((sum, o) => sum + ((o.amountTotal || o.pricing?.total || 0) - (o.platformFeeAmount || o.pricing?.platformFee || 0)), 0)
    };
    if (user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(user.company);
      if (company) {
        const companyOrders = await Order.find({ provider: { $in: company.members.map(m => m.user) } });
        stats.company = {
          total: companyOrders.length,
          inProgress: companyOrders.filter(o => o.status === 'in_progress').length,
          completed: companyOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
          released: companyOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).length,
          totalEarnings: companyOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).reduce((sum, o) => sum + ((o.amountTotal || o.pricing?.total || 0) - (o.platformFeeAmount || o.pricing?.platformFee || 0)), 0),
          providersCount: company.members.length
        };
      }
    }
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Order stats error:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk zleceń', error: error.message });
  }
});

// GET /api/orders/my - moje zlecenia - MUSI być przed GET /:id
router.get('/my', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;
    const filter = { $or: [{ client: userId }, { provider: userId }] };
    if (req.user?.role === 'provider') {
      try {
        const Offer = require('../models/Offer');
        const offerOrderIds = await Offer.distinct('orderId', { providerId: userId });
        if (Array.isArray(offerOrderIds) && offerOrderIds.length > 0) filter.$or.push({ _id: { $in: offerOrderIds } });
      } catch (e) { console.error('My orders (provider offers) error:', e); }
    }
    if (status && status !== 'all') {
      if (status === 'open') filter.status = { $in: ['open', 'collecting_offers'] };
      else filter.status = status;
    }
    const orders = await Order.find(filter).populate('client', 'name email').populate('provider', 'name email').sort({ createdAt: -1 }).skip(skip).limit(limitNum);
    const total = await Order.countDocuments(filter);
    res.json({ orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
  } catch (error) {
    console.error('My orders error:', error);
    res.status(500).json({ message: 'Błąd pobierania zleceń' });
  }
});

// POST /api/orders/:id/proposals - składanie ofert przez usługodawców
// Polityka limitów: darmowe odpowiedzi wg planu, potem opłata (boost lub fee)
router.post('/:id/proposals', auth, async (req, res) => {
  try {
    const { price, estimatedTime, comment } = req.body;
    const orderId = req.params.id;
    const providerId = req.user._id;
    
    // Sprawdź czy zlecenie istnieje i jest otwarte
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie zostało znalezione' });
    }
    
    if (order.status !== 'open') {
      return res.status(400).json({ message: 'Zlecenie nie jest już otwarte' });
    }
    
    // Sprawdź czy usługodawca już złożył ofertę
    const existingProposal = order.proposals?.find(p => p.providerId.toString() === providerId.toString());
    if (existingProposal) {
      return res.status(400).json({ message: 'Już złożyłeś ofertę dla tego zlecenia' });
    }
    
    // Sprawdź limity wg planu użytkownika (provider)
    const UserSubscription = require('../models/UserSubscription');
    const subs = await UserSubscription.findOne({ user: providerId, validUntil: { $gt: new Date() }});
    const planKey = subs?.planKey || 'PROV_FREE';
    const isBusinessPlan = subs?.isBusinessPlan || false;
    const useCompanyPool = subs?.useCompanyResourcePool || false;
    
    // Sprawdź najpierw resource pool firmy (jeśli provider należy do firmy i ma business plan)
    let canUseFromPool = false;
    if (isBusinessPlan && useCompanyPool) {
      const provider = await User.findById(providerId).populate('company');
      if (provider && provider.company) {
        const { canUseCompanyResource } = require('../utils/resourcePool');
        const check = await canUseCompanyResource(providerId, 'providerResponses', 1);
        if (check.allowed) {
          canUseFromPool = true;
        }
      }
    }

    // Limity miesięczne: FREE 10, STANDARD 50, PRO ∞
    // Używamy kluczy: PROV_FREE, PROV_STD, PROV_PRO (zgodnie z SubscriptionPlan)
    const freeLimits = { 
      'PROV_FREE': 10, 
      'PROVIDER_FREE': 10, // backward compatibility
      'PROV_STD': 50,
      'PROVIDER_STANDARD': 50, // backward compatibility
      'PROV_PRO': Infinity,
      'PROVIDER_PRO': Infinity // backward compatibility
    };
    const limit = freeLimits[planKey] ?? 10;

    // Policz odpowiedzi providera w tym miesiącu
    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
    const OrderModel = require('../models/Order');
    const monthReplies = await OrderModel.aggregate([
      { $match: { 'proposals.providerId': providerId, createdAt: { $gte: startOfMonth } } },
      { $project: { proposals: 1 } },
      { $unwind: '$proposals' },
      { $match: { 'proposals.providerId': providerId } },
      { $count: 'count' }
    ]).then(r => r[0]?.count || 0).catch(()=>0);

    // ENFORCE LIMITS - blokuj jeśli przekroczono limit (chyba że może użyć z puli firmowej)
    if (!canUseFromPool && limit !== Infinity && monthReplies >= limit) {
      // Sprawdź czy użytkownik chce zapłacić za dodatkowe odpowiedzi (pay-per-use)
      const { payPerUse } = req.body || {};
      
      if (payPerUse === true) {
        // Pay-per-use: 2 zł za odpowiedź (200 groszy)
        const payPerUsePrice = 200; // grosze
        
        // W trybie development - od razu pozwól
        if (process.env.NODE_ENV === 'development') {
          // Kontynuuj normalnie - odpowiedź została opłacona
        } else {
          // Produkcja - wymagaj płatności przez Stripe
          const Stripe = require('stripe');
          const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
          
          if (!stripe) {
            return res.status(500).json({ message: 'Płatności nie są skonfigurowane' });
          }
          
          const intent = await stripe.paymentIntents.create({
            amount: payPerUsePrice,
            currency: 'pln',
            payment_method_types: ['card', 'p24'],
            description: `Helpfli Provider Response - dodatkowa odpowiedź`,
            metadata: {
              type: 'provider_response_pay_per_use',
              userId: String(req.user._id),
              orderId: String(orderId),
              usageCount: monthReplies + 1
            }
          });
          
          return res.status(402).json({
            requiresPayment: true,
            message: 'Wymagana płatność za dodatkową odpowiedź',
            paymentIntentId: intent.id,
            clientSecret: intent.client_secret,
            amount: payPerUsePrice,
            pricePLN: (payPerUsePrice / 100).toFixed(2),
            upsell: {
              recommendedPlanKey: 'PROV_PRO',
              title: 'PRO – nielimitowane odpowiedzi',
              description: 'Lub wykup plan PRO za 149 zł/mies aby uzyskać nielimitowany dostęp.',
            }
          });
        }
      } else {
        // Utwórz powiadomienie zamiast zwracania błędu
        const Notification = require('../models/Notification');
        
        // Sprawdź czy już nie ma powiadomienia o przekroczeniu limitu (aby nie spamować)
        const existingNotification = await Notification.findOne({
          user: req.user._id,
          type: 'limit_exceeded',
          read: false,
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Ostatnie 24h
        });
        
        if (!existingNotification) {
          await Notification.create({
            user: req.user._id,
            type: 'limit_exceeded',
            title: 'Przekroczono limit odpowiedzi',
            message: `Wykorzystałeś wszystkie darmowe odpowiedzi w tym miesiącu (${limit}). Wykup pakiet PRO lub zapłać za dodatkową odpowiedź.`,
            link: '/account/subscriptions',
            metadata: {
              limit,
              used: monthReplies,
              planKey,
              payPerUseAvailable: true,
              payPerUsePrice: 2.00,
              upsell: {
                recommendedPlanKey: 'PROV_PRO',
                title: 'PRO – nielimitowane odpowiedzi',
                description: 'Otrzymaj nielimitowany dostęp do składania ofert i zwiększ swoje szanse na zlecenia.'
              }
            }
          });
        }
        
        return res.status(403).json({ 
          message: `Przekroczono limit darmowych wycen (${limit}/miesiąc). Sprawdź powiadomienia aby zobaczyć szczegóły.`
        });
      }
    }

    let requireFee = false;

    // Dodaj ofertę
    const proposal = {
      providerId,
      price: Number(price),
      estimatedTime,
      comment,
      createdAt: new Date()
    };
    
    if (!order.proposals) order.proposals = [];
    order.proposals.push(proposal);
    await order.save();
    
    // Zapisz użycie w UsageAnalytics
    try {
      const UsageAnalytics = require('../models/UsageAnalytics');
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await UsageAnalytics.incrementUsage(providerId, monthKey, 'providerResponses', 1, false);
    } catch (analyticsError) {
      console.error('Error saving provider response usage analytics:', analyticsError);
    }
    
    // Wyślij powiadomienie do klienta o nowej wycenie
    try {
      await NotificationService.notifyNewQuote(orderId, providerId);
    } catch (error) {
      console.error('Notification error:', error);
    }
    
    res.json({ message: 'Oferta została złożona', proposal, requireFee });
  } catch (err) {
    console.error('POST_PROPOSAL_ERROR:', err);
    res.status(500).json({ message: 'Błąd składania oferty' });
  }
});

// PATCH /api/orders/:id/payment-method - aktualizacja metody płatności
router.patch('/:id/payment-method', auth, async (req, res) => {
  try {
    const { paymentMethod } = req.body;
    if (!['system', 'external'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Nieprawidłowa metoda płatności' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie zostało znalezione' });
    }

    // "system/external" steruje flow i trafia do paymentPreference.
    order.paymentPreference = paymentMethod;
    await order.save();

    res.json({ message: 'Metoda płatności zaktualizowana', order });
  } catch (err) {
    console.error('UPDATE_PAYMENT_METHOD_ERROR:', err);
    res.status(500).json({ message: 'Błąd aktualizacji metody płatności' });
  }
});

// PATCH /api/orders/:id - edycja zlecenia przez klienta (tylko open / collecting_offers)
router.patch('/:id', auth, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może edytować to zlecenie' });
    }
    if (order.status !== 'open' && order.status !== 'collecting_offers') {
      return res.status(400).json({ message: 'Edycja możliwa tylko dla zleceń otwartych lub zbierających oferty' });
    }

    const allowed = ['description', 'location', 'budget', 'urgency', 'serviceDetails'];
    const { budgetRange } = req.body;
    if (typeof req.body.description !== 'undefined') order.description = req.body.description;
    if (typeof req.body.serviceDetails !== 'undefined') order.serviceDetails = req.body.serviceDetails;
    if (typeof req.body.urgency !== 'undefined') {
      if (!['now', 'today', 'tomorrow', 'this_week', 'flexible'].includes(req.body.urgency)) {
        return res.status(400).json({ message: 'Nieprawidłowa wartość pilności' });
      }
      order.urgency = req.body.urgency;
    }
    if (typeof req.body.budget !== 'undefined') order.budget = req.body.budget == null ? null : Number(req.body.budget);
    if (budgetRange) {
      order.budgetRange = order.budgetRange || {};
      if (typeof budgetRange.min !== 'undefined') order.budgetRange.min = budgetRange.min == null ? null : Number(budgetRange.min);
      if (typeof budgetRange.max !== 'undefined') order.budgetRange.max = budgetRange.max == null ? null : Number(budgetRange.max);
    }
    if (typeof req.body.location !== 'undefined') {
      const loc = req.body.location;
      const addr = typeof loc === 'string' ? loc : (loc && typeof loc === 'object' ? loc.address : undefined);
      if (addr !== undefined) {
        if (!order.location || typeof order.location !== 'object') order.location = {};
        order.location.address = addr;
      }
    }

    await order.save();
    res.json({ message: 'Zlecenie zaktualizowane', order });
  } catch (e) {
    console.error('PATCH order error:', e);
    res.status(500).json({ message: 'Błąd aktualizacji zlecenia' });
  }
});

// GET /api/orders/:id - szczegóły zlecenia
// GET /api/orders/:id/timeline - historia zmian statusu zlecenia
router.get('/:id/timeline', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('client', 'name email')
      .populate('provider', 'name email');
    
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    // Sprawdź uprawnienia
    const userId = req.user._id;
    const isClient = order.client._id.toString() === userId.toString();
    const isProvider = order.provider && order.provider._id.toString() === userId.toString();
    let isCompanyView = false;
    if (!isClient && !isProvider && req.user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(req.user.company).lean();
      if (company) {
        const providerId = order.provider?._id?.toString() || order.provider?.toString();
        const memberIds = [company.owner?.toString(), ...(company.managers || []).map(m => m.toString()), ...(company.providers || []).map(p => p.toString())].filter(Boolean);
        if (providerId && memberIds.includes(providerId)) isCompanyView = true;
      }
    }
    if (!isClient && !isProvider && !isCompanyView && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const timeline = [];

    // Utworzenie zlecenia
    if (order.createdAt) {
      timeline.push({
        type: 'created',
        label: 'Zlecenie utworzone',
        date: order.createdAt,
        user: order.client.name || order.client.email
      });
    }

    // Oferty złożone
    if (order.offers && order.offers.length > 0) {
      const firstOffer = order.offers.reduce((earliest, offer) => {
        return (!earliest || (offer.date && offer.date < earliest.date)) ? offer : earliest;
      }, null);
      
      if (firstOffer) {
        timeline.push({
          type: 'offers',
          label: `${order.offers.length} ${order.offers.length === 1 ? 'oferta złożona' : 'oferty złożone'}`,
          date: firstOffer.date || order.createdAt,
          count: order.offers.length
        });
      }
    }

    // Oferta zaakceptowana
    if (order.status === 'accepted' || order.acceptedOfferId || order.selectedOffer) {
      const acceptedOffer = order.offers?.find(o => 
        o._id.toString() === (order.acceptedOfferId?.toString() || order.selectedOffer?.toString())
      );
      
      timeline.push({
        type: 'accepted',
        label: 'Oferta zaakceptowana',
        date: order.updatedAt,
        offer: acceptedOffer ? {
          provider: acceptedOffer.provider,
          price: acceptedOffer.price
        } : null
      });
    }

    // Opłacone
    if (order.paymentStatus === 'succeeded' || order.paidInSystem || order.status === 'funded') {
      timeline.push({
        type: 'paid',
        label: 'Zlecenie opłacone',
        date: order.updatedAt,
        amount: order.amountTotal || order.pricing?.total || 0
      });
    }

    // W realizacji
    if (order.status === 'in_progress') {
      timeline.push({
        type: 'in_progress',
        label: 'Rozpoczęto realizację',
        date: order.updatedAt
      });
    }

    // Zakończone
    if (order.status === 'completed' || order.status === 'rated') {
      timeline.push({
        type: 'completed',
        label: 'Zlecenie zakończone',
        date: order.completedAt || order.updatedAt
      });
    }

    // Odbiór potwierdzony (released) – klient potwierdził, środki przekazane wykonawcy
    if (order.status === 'released') {
      timeline.push({
        type: 'released',
        label: 'Odbiór potwierdzony',
        date: order.updatedAt
      });
    }

    // Spór
    if (order.disputeStatus && order.disputeStatus !== 'none') {
      timeline.push({
        type: 'disputed',
        label: `Spór zgłoszony: ${order.disputeStatus}`,
        date: order.disputeReportedAt || order.updatedAt,
        reason: order.disputeReason
      });
    }

    // Sortuj chronologicznie
    timeline.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({
      success: true,
      timeline
    });
  } catch (error) {
    console.error('Timeline error:', error);
    res.status(500).json({ message: 'Błąd pobierania timeline', error: error.message });
  }
});

// GET /api/orders/:orderId/attachments/resolve-file?url=... — gdy frontend nie ma subdoc _id (np. stary zapis), dopasowanie po zapisanym url
// MUSI być przed /:attachmentId/file
router.get('/:orderId/attachments/resolve-file', auth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const storedUrl = req.query.url;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ message: 'Nieprawidłowy identyfikator zlecenia' });
    }
    if (!storedUrl || typeof storedUrl !== 'string' || storedUrl.length > 2048) {
      return res.status(400).json({ message: 'Brak lub nieprawidłowy parametr url' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Zlecenie nie znalezione' });

    const userId = req.user._id.toString();
    const isOwner = order.client.toString() === userId;
    const isProviderUser = req.user.role === 'provider';
    const isAdmin = req.user.role === 'admin';

    let isCompanyView = false;
    if (!isOwner && !isProviderUser && !isAdmin && req.user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(req.user.company).lean();
      if (company) {
        const providerId = order.provider?.toString();
        const memberIds = [
          company.owner?.toString(),
          ...(company.managers || []).map((m) => m.toString()),
          ...(company.providers || []).map((p) => p.toString()),
        ].filter(Boolean);
        if (providerId && memberIds.includes(providerId)) isCompanyView = true;
      }
    }

    if (!isOwner && !isProviderUser && !isAdmin && !isCompanyView) {
      return res.status(403).json({ message: 'Brak dostępu' });
    }

    const att = (order.attachments || []).find((a) => a && attachmentStoredUrlsMatch(a.url, storedUrl));
    if (!att) return res.status(404).json({ message: 'Załącznik nie znaleziony' });

    const diskPath = resolveOrderAttachmentDiskPath(att.url);
    if (!diskPath || !fs.existsSync(diskPath)) {
      return res.status(404).json({ message: 'Plik nie istnieje na serwerze' });
    }

    const mime = att.mimeType || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(diskPath, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ message: 'Błąd wysyłania pliku' });
      }
    });
  } catch (e) {
    console.error('GET /orders/.../attachments/resolve-file', e);
    res.status(500).json({ message: 'Błąd pobierania pliku' });
  }
});

// GET /api/orders/:orderId/attachments/:attachmentId/file — pobranie pliku z JWT ( <img> nie wysyła Bearer na /uploads )
// MUSI być przed GET /:id
router.get('/:orderId/attachments/:attachmentId/file', auth, async (req, res) => {
  try {
    const { orderId, attachmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId) || !mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ message: 'Nieprawidłowy identyfikator' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Zlecenie nie znalezione' });

    const userId = req.user._id.toString();
    const isOwner = order.client.toString() === userId;
    const isProviderUser = req.user.role === 'provider';
    const isAdmin = req.user.role === 'admin';

    let isCompanyView = false;
    if (!isOwner && !isProviderUser && !isAdmin && req.user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(req.user.company).lean();
      if (company) {
        const providerId = order.provider?.toString();
        const memberIds = [
          company.owner?.toString(),
          ...(company.managers || []).map((m) => m.toString()),
          ...(company.providers || []).map((p) => p.toString()),
        ].filter(Boolean);
        if (providerId && memberIds.includes(providerId)) isCompanyView = true;
      }
    }

    if (!isOwner && !isProviderUser && !isAdmin && !isCompanyView) {
      return res.status(403).json({ message: 'Brak dostępu' });
    }

    const att = order.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ message: 'Załącznik nie znaleziony' });

    const diskPath = resolveOrderAttachmentDiskPath(att.url);
    if (!diskPath || !fs.existsSync(diskPath)) {
      return res.status(404).json({ message: 'Plik nie istnieje na serwerze' });
    }

    const mime = att.mimeType || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(diskPath, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ message: 'Błąd wysyłania pliku' });
      }
    });
  } catch (e) {
    console.error('GET /orders/.../attachments/.../file', e);
    res.status(500).json({ message: 'Błąd pobierania pliku' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const Offer = require("../models/Offer");
    const logger = require("../utils/logger");
    
    // Walidacja ObjectId
    if (!orderId || orderId === 'my' || !/^[0-9a-fA-F]{24}$/.test(orderId)) {
      return res.status(400).json({ message: 'Nieprawidłowy identyfikator zlecenia' });
    }
    
    const order = await Order.findById(orderId)
      .populate('client', 'name email phone')
      .populate('provider', 'name email phone')
      .populate('acceptedOfferId')
      .lean();
    
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie zostało znalezione' });
    }
    
    // Sprawdź uprawnienia
    const isOwner = order.client._id.toString() === req.user._id.toString();
    const isProvider = req.user.role === 'provider';
    const isAssignedProvider = order.provider && (order.provider._id?.toString() || order.provider.toString()) === req.user._id.toString();

    // Firma (owner/manager) może podejrzeć zlecenie, jeśli wykonawcą jest pracownik tej firmy
    let isCompanyView = false;
    if (!isOwner && !isAssignedProvider && req.user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(req.user.company).lean();
      if (company) {
        const providerId = order.provider?._id?.toString() || order.provider?.toString();
        const memberIds = [
          company.owner?.toString(),
          ...(company.managers || []).map(m => m.toString()),
          ...(company.providers || []).map(p => p.toString())
        ].filter(Boolean);
        if (providerId && memberIds.includes(providerId)) {
          isCompanyView = true;
        }
      }
    }

    if (!isOwner && !isProvider && !isCompanyView) {
      return res.status(403).json({ message: 'Brak dostępu do tego zlecenia' });
    }

    // Pobierz oferty
    let offers = [];
    if (isOwner || isCompanyView) {
      // Klient lub firma (podgląd) widzi wszystkie oferty
      offers = await Offer.find({ orderId: order._id })
        .populate('providerId', 'name email phone avatar level providerLevel badges')
        .sort({ createdAt: -1 })
        .lean();
    } else if (isProvider) {
      // Provider widzi tylko swoje oferty
      offers = await Offer.find({ 
        orderId: order._id, 
        providerId: req.user._id 
      })
        .populate('providerId', 'name email phone avatar level providerLevel badges')
        .sort({ createdAt: -1 })
        .lean();
    }
    
    // Dodaj oferty do order object
    order.offers = offers;
    
    // Sprawdź eligibility gwarancji (jeśli provider jest przypisany)
    if (order.provider) {
      try {
        const { checkGuaranteeEligibility } = require("../utils/guarantee");
        const result = await checkGuaranteeEligibility({
          paymentMethod: order.paymentMethod || "system",
          providerId: order.provider._id || order.provider,
          orderStatus: order.status,
        });
        order.eligibleForGuarantee = result.eligible;
        order.guaranteeReasons = result.reasons;
      } catch (guaranteeError) {
        logger.warn('GUARANTEE_CHECK_ERROR:', guaranteeError.message);
        order.eligibleForGuarantee = false;
        order.guaranteeReasons = [];
      }
    }
    
    res.json(order);
  } catch (err) {
    const logger = require("../utils/logger");
    logger.error('GET_ORDER_ERROR:', {
      message: err.message,
      stack: err.stack,
      orderId: req.params?.id,
      userId: req.user?._id
    });
    res.status(500).json({ message: 'Błąd pobierania zlecenia' });
  }
});

// Funkcja do obliczania dystansu (wzór haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Promień Ziemi w km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  return Math.round(distance * 10) / 10; // Zaokrąglenie do 1 miejsca po przecinku
}

// Middleware do ładowania zlecenia
async function loadOrderById(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });
    req.order = order;
    next();
  } catch (e) {
    res.status(500).json({ message: 'Błąd ładowania zlecenia' });
  }
}

// Endpoint statusu ochrony — do UI
router.get('/:id/protection', auth, loadOrderById, async (req, res) => {
  const o = req.order;
  res.json({
    paidInSystem: o.paidInSystem,
    paymentStatus: o.paymentStatus,
    protectionStatus: o.protectionStatus,
    protectionExpiresAt: o.protectionExpiresAt,
  });
});

// Akceptacja zlecenia (provider) - wymaga KYC
router.post('/:id/accept', auth, requireKycVerified, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    
    // Sprawdź czy użytkownik to provider
    if (order.provider && String(order.provider) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko przypisany wykonawca może zaakceptować zlecenie' });
    }
    
    // Sprawdź status zlecenia
    if (order.status !== 'open' && order.status !== 'pending') {
      return res.status(400).json({ message: 'Zlecenie nie może być zaakceptowane w tym statusie' });
    }
    
    order.status = 'accepted';
    order.acceptedAt = new Date();
    await order.save();
    
    // Wyślij powiadomienie do klienta
    try {
      await NotificationService.notifyOrderAccepted(order._id);
    } catch (error) {
      console.error('Notification error:', error);
    }
    
    res.json({ message: 'Zlecenie zaakceptowane', order });
  } catch (e) {
    console.error('Accept order error:', e);
    res.status(500).json({ message: 'Błąd akceptacji zlecenia' });
  }
});

// FUND – blokada środków (escrow) po akceptacji oferty
router.post('/:id/fund', auth, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    // tylko klient może fundować
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może opłacić zlecenie' });
    }
    // status przejściowy
    order.status = 'funded';
    // Enum paymentStatus nie zawiera "requires_capture"; używamy stanu przejściowego "processing".
    order.paymentStatus = 'processing';
    await order.save();

    // Emit Socket.IO event do pokoju order
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${order._id}`).emit("order:status_changed", { 
        orderId: order._id, 
        status: 'funded',
        action: 'funded'
      });
    }

    await Revenue.create({
      orderId: order._id,
      clientId: req.user._id,
      type: 'escrow',
      amount: order.budget ? Number(order.budget) * 100 : 0,
      description: `Escrow for order ${order.service}`,
      status: 'pending',
    });
    res.json({ message: 'Środki zostały zabezpieczone (escrow)', order });
  } catch (e) {
    console.error('FUND_ERROR:', e);
    res.status(500).json({ message: 'Błąd zabezpieczenia środków' });
  }
});

// Potwierdzenie odbioru przez klienta → uwolnienie środków
router.post('/:id/confirm-receipt', auth, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może potwierdzić odbiór' });
    }

    // 1) Jeśli mamy płatność Stripe powiązaną ze zleceniem – wykonaj capture (prawdziwy escrow)
    if (stripe) {
      try {
        const payment = await Payment.findOne({ order: order._id }).sort({ createdAt: -1 });
        if (payment && payment.stripePaymentIntentId) {
          try {
            const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
            if (intent.status === "requires_capture") {
              const captured = await stripe.paymentIntents.capture(payment.stripePaymentIntentId);
              if (captured.status === "succeeded") {
                payment.status = "succeeded";
                await payment.save();
                order.paymentStatus = "succeeded";
                order.paidInSystem = true;
                order.protectionEligible = true;
                order.protectionStatus = "active";
                order.protectionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
              }
            }
          } catch (captureErr) {
            // Jeśli PaymentIntent jest już skapturowany, zignoruj błąd stanu
            if (captureErr?.code !== "payment_intent_unexpected_state") {
              console.error("Stripe capture error in confirm-receipt:", captureErr);
            }
          }
        }
      } catch (e) {
        console.error("Order confirm-receipt payment lookup error:", e);
      }
    }

    // 2) Aktualizuj status zlecenia i revenue (logiczny „release”)
    order.status = 'released';
    if (order.paymentStatus === 'unpaid' || !order.paymentStatus) {
      order.paymentStatus = 'succeeded';
    }
    await order.save();

    await Revenue.updateMany(
      { orderId: order._id, type: 'escrow', status: 'pending' },
      { $set: { status: 'paid', releasedAt: new Date() } }
    );
    
    // Emit Socket.IO event do pokoju order
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${order._id}`).emit("order:status_changed", { 
        orderId: order._id, 
        status: 'released',
        action: 'released'
      });
    }
    
    // Wyślij powiadomienie o wypłacie do providera
    try {
      await NotificationService.notifyPaymentReceived(order._id);
    } catch (error) {
      console.error('Notification error:', error);
    }
    
    res.json({ message: 'Środki wypłacone wykonawcy', order });
  } catch (e) {
    console.error('CONFIRM_RECEIPT_ERROR:', e);
    res.status(500).json({ message: 'Błąd potwierdzania odbioru' });
  }
});

// Start pracy / oznaczenie „in progress" - wymaga KYC
router.post('/:id/start', auth, requireKycVerified, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    
    // Sprawdź czy użytkownik to provider
    if (order.provider && String(order.provider) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko przypisany wykonawca może rozpocząć pracę' });
    }
    
    // Sprawdź status zlecenia
    if (order.status !== 'accepted') {
      return res.status(400).json({ message: 'Zlecenie musi być zaakceptowane przed rozpoczęciem pracy' });
    }
    
    // Dla płatności przez system - sprawdź czy płatność została wykonana
    if (order.paymentMethod === 'system' && order.paymentStatus !== 'succeeded' && !order.paidInSystem) {
      return res.status(400).json({ message: 'Zlecenie musi być opłacone przed rozpoczęciem pracy (paymentMethod: system)' });
    }
    
    order.status = 'in_progress';
    order.startedAt = new Date();
    await order.save();
    
    // Emit Socket.IO event do pokoju order
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${order._id}`).emit("order:status_changed", { 
        orderId: order._id, 
        status: 'in_progress',
        action: 'started'
      });
    }
    
    res.json({ message: 'Praca rozpoczęta', order });
  } catch (e) {
    console.error('Start work error:', e);
    res.status(500).json({ message: 'Błąd rozpoczęcia pracy' });
  }
});

// Wydłużenie czasu aktywności zlecenia (tylko klient)
router.post('/:id/extend', auth, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    const { hours, reason } = req.body; // hours - ile godzin dodać, reason - powód (opcjonalnie)
    
    // Sprawdź czy użytkownik to klient zlecenia
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może wydłużyć czas zlecenia' });
    }
    
    // Sprawdź czy zlecenie jest jeszcze aktywne (open lub collecting_offers)
    if (order.status !== 'open' && order.status !== 'collecting_offers') {
      return res.status(400).json({ message: 'Można wydłużyć tylko aktywne zlecenia' });
    }
    
    // Domyślnie dodaj 24 godziny
    const extendHours = hours ? parseInt(hours) : 24;
    if (extendHours <= 0 || extendHours > 168) { // max 7 dni
      return res.status(400).json({ message: 'Czas wydłużenia musi być między 1 a 168 godzinami (7 dni)' });
    }
    
    const now = new Date();
    const currentExpiresAt = order.expiresAt || now;
    
    // Jeśli zlecenie już wygasło, ustaw nową datę od teraz
    // Jeśli jeszcze nie wygasło, dodaj do aktualnej daty wygaśnięcia
    const newExpiresAt = currentExpiresAt < now 
      ? new Date(now.getTime() + extendHours * 60 * 60 * 1000)
      : new Date(currentExpiresAt.getTime() + extendHours * 60 * 60 * 1000);
    
    // Zaktualizuj zlecenie
    order.expiresAt = newExpiresAt;
    order.extendedCount = (order.extendedCount || 0) + 1;
    order.lastExtendedAt = now;
    order.extensionReason = reason || 'Wydłużone przez klienta';
    order.autoExtended = false;
    
    await order.save();
    
    res.json({ 
      message: `Czas zlecenia został wydłużony o ${extendHours} godzin`,
      expiresAt: order.expiresAt,
      extendedCount: order.extendedCount
    });
  } catch (e) {
    console.error('Extend order error:', e);
    res.status(500).json({ message: 'Błąd wydłużania zlecenia' });
  }
});

// Zakończenie zlecenia (rozliczenie) - wymaga KYC
router.post('/:id/complete', auth, requireKycVerified, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    
    // Sprawdź czy użytkownik to provider
    if (order.provider && String(order.provider) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko przypisany wykonawca może zakończyć zlecenie' });
    }
    
    // Sprawdź status zlecenia
    if (order.status !== 'in_progress') {
      return res.status(400).json({ message: 'Zlecenie musi być w trakcie realizacji' });
    }
    
    // Pobierz dane zakończenia z body
    const { completionType, completionNotes, additionalAmount, paymentReason } = req.body;
    
    // Walidacja completionType
    if (completionType && !['simple', 'with_notes', 'with_payment'].includes(completionType)) {
      return res.status(400).json({ message: 'Nieprawidłowy typ zakończenia' });
    }
    
    // Walidacja dla 'with_notes'
    if (completionType === 'with_notes' && (!completionNotes || !completionNotes.trim())) {
      return res.status(400).json({ message: 'Uwagi są wymagane przy zakończeniu z uwagami' });
    }
    
    // Walidacja dla 'with_payment'
    if (completionType === 'with_payment') {
      if (!additionalAmount || parseFloat(additionalAmount) <= 0) {
        return res.status(400).json({ message: 'Kwota dopłaty musi być większa od 0' });
      }
      if (!paymentReason || !paymentReason.trim()) {
        return res.status(400).json({ message: 'Uzasadnienie dopłaty jest wymagane' });
      }
    }
    
    const completedAt = new Date();
    order.status = 'completed';
    order.completedAt = completedAt;
    
    // Zapisz dane zakończenia
    if (completionType) {
      order.completionType = completionType;
    }
    if (completionNotes) {
      order.completionNotes = completionNotes.trim();
    }
    if (additionalAmount) {
      order.additionalAmount = parseFloat(additionalAmount);
    }
    if (paymentReason) {
      order.paymentReason = paymentReason.trim();
    }
    
    // Oblicz czy zlecenie zostało ukończone na czas
    let expectedDate = null;
    
    // 1. Sprawdź termin z zaakceptowanej oferty
    if (order.acceptedOfferId) {
      const Offer = require('../models/Offer');
      const offer = await Offer.findById(order.acceptedOfferId);
      if (offer && offer.completionDate) {
        expectedDate = new Date(offer.completionDate);
      }
    }
    
    // 2. Jeśli nie ma oferty, użyj priorityDateTime jako fallback
    if (!expectedDate && order.priorityDateTime) {
      expectedDate = new Date(order.priorityDateTime);
    }
    
    // 3. Ustaw deliveredOnTime (true jeśli ukończone przed terminem lub w terminie)
    if (expectedDate) {
      order.deliveredOnTime = completedAt <= expectedDate;
    } else {
      // Jeśli nie ma terminu, ustaw null (nie określono)
      order.deliveredOnTime = null;
    }
    
    await order.save();
    
    // Emit Socket.IO event do pokoju order
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${order._id}`).emit("order:status_changed", { 
        orderId: order._id, 
        status: 'completed',
        action: 'completed'
      });
    }
    
    // Wyślij powiadomienie do klienta
    try {
      await NotificationService.notifyOrderCompleted(order._id);
    } catch (error) {
      console.error('Notification error:', error);
    }
    
    // Wywołaj Post-Order Agent dla personalizacji follow-up
    let postOrderResult = null;
    try {
      const postOrderAgent = getPostOrderAgent();
      if (postOrderAgent) {
        // Określ kod usługi z order obiektu (który już mamy w pamięci)
        let serviceCode = 'inne';
        if (order.service) {
          // Jeśli service to ObjectId, musimy pobrać kod z Service modelu
          if (typeof order.service === 'object' && order.service.code) {
            serviceCode = order.service.code;
          } else if (typeof order.service === 'string' && order.service.length > 3) {
            // Może być kod usługi jako string
            serviceCode = order.service;
          } else {
            // Spróbuj pobrać z bazy (opcjonalnie, tylko jeśli potrzeba)
            try {
              const serviceObj = await Service.findById(order.service).lean();
              if (serviceObj && serviceObj.code) {
                serviceCode = serviceObj.code;
              }
            } catch (e) {
              // Ignoruj błąd - użyj domyślnego 'inne'
            }
          }
        }
        
        postOrderResult = await postOrderAgent({
          service: serviceCode,
          outcome: 'completed',
          paidInApp: order.paidInSystem || false,
          rating: null // Ocena może być dodana później przez użytkownika
        });
        
        // Zapisz wynik Post-Order agenta do zlecenia (opcjonalnie)
        if (postOrderResult && postOrderResult.ok) {
          order.aiPostOrderMessage = postOrderResult.messageToClient;
          order.aiFollowUpSuggestion = postOrderResult.followUp;
          // Nie zapisujemy ponownie - order już został zapisany wyżej
        }
      }
    } catch (postOrderError) {
      console.error('Post-Order Agent error:', postOrderError);
      // Nie przerywamy procesu - Post-Order agent to nice-to-have
    }
    
    res.json({ 
      message: 'Zlecenie zakończone', 
      order,
      ai: postOrderResult || null // Zwróć wynik Post-Order agenta (dla frontendu)
    });
  } catch (e) {
    console.error('Complete order error:', e);
    res.status(500).json({ message: 'Błąd zakończenia zlecenia' });
  }
});

// POST /api/orders/:id/attachments - upload plików do zlecenia
router.post('/:id/attachments', auth, upload.array('files', 5), async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);
    
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }
    
    // Sprawdź czy użytkownik to właściciel zlecenia
    if (order.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Brak uprawnień do tego zlecenia' });
    }
    
    // Dodaj nowe pliki do zlecenia
    const newAttachments = (req.files || []).map(file => ({
      url: toPublicUrl(file.filename),
      mimeType: file.mimetype,
      filename: file.originalname,
      size: file.size
    }));
    
    order.attachments = [...(order.attachments || []), ...newAttachments];
    await order.save();
    
    res.json({ 
      message: 'Pliki zostały dodane',
      attachments: newAttachments,
      totalAttachments: order.attachments.length
    });
  } catch (error) {
    console.error('Upload attachments error:', error);
    res.status(500).json({ message: 'Błąd uploadu plików' });
  }
});

// DELETE /api/orders/:id/attachments/:attachmentId - usuń plik z zlecenia
router.delete('/:id/attachments/:attachmentId', auth, async (req, res) => {
  try {
    const { id, attachmentId } = req.params;
    const order = await Order.findById(id);
    
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }
    
    // Sprawdź czy użytkownik to właściciel zlecenia
    if (order.client.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Brak uprawnień do tego zlecenia' });
    }
    
    // Znajdź i usuń załącznik
    const attachment = order.attachments.id(attachmentId);
    if (!attachment) {
      return res.status(404).json({ message: 'Załącznik nie znaleziony' });
    }
    
    // Usuń plik z dysku
    const fs = require('fs');
    const filePath = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'orders', path.basename(attachment.url));
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting file:', err);
    });
    
    // Usuń z bazy danych
    order.attachments.pull(attachmentId);
    await order.save();
    
    res.json({ message: 'Załącznik został usunięty' });
  } catch (error) {
    console.error('Delete attachment error:', error);
    res.status(500).json({ message: 'Błąd usuwania załącznika' });
  }
});

// POST /api/orders/:id/invoice - upload faktury przez providera (tylko dla completed orders)
router.post('/:id/invoice', auth, uploadInvoice.single('invoice'), async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id).populate('client');
    
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }
    
    // Sprawdź czy użytkownik to provider zlecenia
    const providerId = order.provider || order.serviceProvider;
    if (!providerId || String(providerId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko wykonawca zlecenia może wrzucić fakturę' });
    }
    
    // Sprawdź czy zlecenie jest zakończone
    if (order.status !== 'completed' && order.status !== 'rated') {
      return res.status(400).json({ message: 'Fakturę można wrzucić tylko dla zakończonych zleceń' });
    }
    
    // Sprawdź czy klient prosił o fakturę
    if (!order.requestInvoice) {
      return res.status(400).json({ message: 'Klient nie prosił o fakturę dla tego zlecenia' });
    }
    
    if (!req.file) {
      return res.status(400).json({ message: 'Brak pliku faktury' });
    }
    
    // Zapisz fakturę w zleceniu
    order.invoice = {
      url: toInvoiceUrl(req.file.filename),
      filename: req.file.originalname,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user._id,
      sentToClient: false
    };
    
    await order.save();
    
    // Wyślij maila do klienta z fakturą
    try {
      const emailService = require('../services/emailService');
      const client = await User.findById(order.client);
      
      if (client && client.email) {
        const baseUrl = process.env.FRONTEND_URL || process.env.API_URL || 'http://localhost:3000';
        const invoiceUrl = `${baseUrl}${order.invoice.url}`;
        
        await emailService.sendEmail({
          to: client.email,
          subject: `Faktura za zlecenie: ${order.service}`,
          template: 'order-invoice',
          context: {
            clientName: client.name || client.email,
            orderService: order.service,
            orderId: order._id,
            invoiceUrl: invoiceUrl,
            providerName: req.user.name || req.user.email
          }
        });
        
        order.invoice.sentToClient = true;
        order.invoice.sentAt = new Date();
        await order.save();
      }
    } catch (emailError) {
      console.error('Error sending invoice email:', emailError);
      // Nie blokuj odpowiedzi jeśli mail się nie powiódł
    }
    
    res.json({
      success: true,
      message: 'Faktura została wrzucona i wysłana do klienta',
      invoice: {
        url: order.invoice.url,
        filename: order.invoice.filename,
        uploadedAt: order.invoice.uploadedAt
      }
    });
  } catch (error) {
    console.error('Upload invoice error:', error);
    res.status(500).json({ message: 'Błąd uploadu faktury', error: error.message });
  }
});

// GET /api/orders/my - moje zlecenia (client/provider)
// GET /api/orders/my/stats - statystyki zleceń dla użytkownika (klient lub provider)
router.get('/my/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    }

    const stats = {
      client: {},
      provider: {}
    };

    // Statystyki jako klient
    const clientOrders = await Order.find({ client: userId });
    stats.client = {
      total: clientOrders.length,
      open: clientOrders.filter(o => o.status === 'open' || o.status === 'collecting_offers').length,
      collectingOffers: clientOrders.filter(o => o.status === 'collecting_offers').length,
      accepted: clientOrders.filter(o => o.status === 'accepted').length,
      paid: clientOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem || o.status === 'funded').length,
      inProgress: clientOrders.filter(o => o.status === 'in_progress').length,
      completed: clientOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
      cancelled: clientOrders.filter(o => o.status === 'cancelled').length,
      disputed: clientOrders.filter(o => o.disputeStatus && o.disputeStatus !== 'none').length,
      totalSpent: clientOrders
        .filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem)
        .reduce((sum, o) => sum + (o.amountTotal || o.pricing?.total || 0), 0)
    };

    // Statystyki jako provider
    const providerOrders = await Order.find({ provider: userId });
    stats.provider = {
      total: providerOrders.length,
      pendingOffers: 0, // Zlecenia na które złożył ofertę ale jeszcze nie zaakceptowana
      accepted: providerOrders.filter(o => o.status === 'accepted').length,
      paid: providerOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem || o.status === 'funded').length,
      inProgress: providerOrders.filter(o => o.status === 'in_progress').length,
      completed: providerOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
      released: providerOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).length,
      cancelled: providerOrders.filter(o => o.status === 'cancelled').length,
      disputed: providerOrders.filter(o => o.disputeStatus && o.disputeStatus !== 'none').length,
      totalEarnings: providerOrders
        .filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid'))
        .reduce((sum, o) => {
          const total = o.amountTotal || o.pricing?.total || 0;
          const platformFee = o.platformFeeAmount || o.pricing?.platformFee || 0;
          return sum + (total - platformFee);
        }, 0)
    };

    // Jeśli użytkownik jest w firmie, dodaj statystyki firmy
    if (user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(user.company);
      if (company) {
        const companyOrders = await Order.find({ 
          provider: { $in: company.members.map(m => m.user) }
        });
        
        stats.company = {
          total: companyOrders.length,
          inProgress: companyOrders.filter(o => o.status === 'in_progress').length,
          completed: companyOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
          released: companyOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).length,
          totalEarnings: companyOrders
            .filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid'))
            .reduce((sum, o) => {
              const total = o.amountTotal || o.pricing?.total || 0;
              const platformFee = o.platformFeeAmount || o.pricing?.platformFee || 0;
              return sum + (total - platformFee);
            }, 0),
          providersCount: company.members.length
        };
      }
    }

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Order stats error:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk zleceń', error: error.message });
  }
});

// GET /api/orders/my/stats - statystyki zleceń dla użytkownika (klient lub provider)
router.get('/my/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    }

    const stats = {
      client: {},
      provider: {}
    };

    // Statystyki jako klient
    const clientOrders = await Order.find({ client: userId });
    stats.client = {
      total: clientOrders.length,
      open: clientOrders.filter(o => o.status === 'open' || o.status === 'collecting_offers').length,
      collectingOffers: clientOrders.filter(o => o.status === 'collecting_offers').length,
      accepted: clientOrders.filter(o => o.status === 'accepted').length,
      paid: clientOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem || o.status === 'funded').length,
      inProgress: clientOrders.filter(o => o.status === 'in_progress').length,
      completed: clientOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
      cancelled: clientOrders.filter(o => o.status === 'cancelled').length,
      disputed: clientOrders.filter(o => o.disputeStatus && o.disputeStatus !== 'none').length,
      totalSpent: clientOrders
        .filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem)
        .reduce((sum, o) => sum + (o.amountTotal || o.pricing?.total || 0), 0)
    };

    // Statystyki jako provider
    const providerOrders = await Order.find({ provider: userId });
    stats.provider = {
      total: providerOrders.length,
      pendingOffers: 0, // Zlecenia na które złożył ofertę ale jeszcze nie zaakceptowana
      accepted: providerOrders.filter(o => o.status === 'accepted').length,
      paid: providerOrders.filter(o => o.paymentStatus === 'succeeded' || o.paidInSystem || o.status === 'funded').length,
      inProgress: providerOrders.filter(o => o.status === 'in_progress').length,
      completed: providerOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
      released: providerOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).length,
      cancelled: providerOrders.filter(o => o.status === 'cancelled').length,
      disputed: providerOrders.filter(o => o.disputeStatus && o.disputeStatus !== 'none').length,
      totalEarnings: providerOrders
        .filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid'))
        .reduce((sum, o) => {
          const total = o.amountTotal || o.pricing?.total || 0;
          const platformFee = o.platformFeeAmount || o.pricing?.platformFee || 0;
          return sum + (total - platformFee);
        }, 0)
    };

    // Jeśli użytkownik jest w firmie, dodaj statystyki firmy
    if (user.company) {
      const Company = require('../models/Company');
      const company = await Company.findById(user.company);
      if (company) {
        const companyOrders = await Order.find({ 
          provider: { $in: company.members.map(m => m.user) }
        });
        
        stats.company = {
          total: companyOrders.length,
          inProgress: companyOrders.filter(o => o.status === 'in_progress').length,
          completed: companyOrders.filter(o => o.status === 'completed' || o.status === 'rated').length,
          released: companyOrders.filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid')).length,
          totalEarnings: companyOrders
            .filter(o => o.status === 'released' || (o.payment && o.payment.status === 'paid'))
            .reduce((sum, o) => {
              const total = o.amountTotal || o.pricing?.total || 0;
              const platformFee = o.platformFeeAmount || o.pricing?.platformFee || 0;
              return sum + (total - platformFee);
            }, 0),
          providersCount: company.members.length
        };
      }
    }

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Order stats error:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk zleceń', error: error.message });
  }
});

// POST /api/orders/:id/boost - podbij zlecenie (przenieś na górę listy)
router.post('/:id/boost', auth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user._id;
    
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }
    
    // Sprawdź uprawnienia - tylko właściciel zlecenia może je podbić
    if (order.client.toString() !== userId.toString()) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }
    
    // Sprawdź czy zlecenie jest otwarte
    if (order.status !== 'open' && order.status !== 'collecting_offers') {
      return res.status(400).json({ message: 'Można podbić tylko otwarte zlecenia' });
    }
    
    // Sprawdź pakiet użytkownika
    const UserSubscription = require('../models/UserSubscription');
    const subscription = await UserSubscription.findOne({ 
      user: userId,
      validUntil: { $gt: new Date() }
    });
    
    const packageType = subscription?.planKey || 'CLIENT_FREE';
    const isPro = packageType === 'CLIENT_PRO';
    const isStandard = packageType === 'CLIENT_STD';
    
    let boostFree = false;
    let paymentRequired = true;
    let paymentAmount = 500; // 5 zł w groszach
    let boostsRemaining = 0;
    
    // Sprawdź limity miesięczne i reset jeśli potrzeba
    const now = new Date();
    const resetDate = subscription?.freeOrderBoostsResetDate;
    const needsReset = !resetDate || 
      resetDate.getMonth() !== now.getMonth() || 
      resetDate.getFullYear() !== now.getFullYear();
    
    if (needsReset && subscription) {
      // Pobierz plan żeby sprawdzić freeBoostsPerMonth
      const SubscriptionPlan = require('../models/SubscriptionPlan');
      const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
      const freeBoostsPerMonth = plan?.freeBoostsPerMonth || 0;
      
      // Reset limitów na nowy miesiąc z planu
      subscription.freeOrderBoostsLimit = freeBoostsPerMonth;
      subscription.freeOrderBoostsLeft = freeBoostsPerMonth;
      subscription.freeOrderBoostsResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
      await subscription.save();
    }
    
    // Sprawdź czy może użyć darmowego podbicia (z planu)
    if (subscription?.freeOrderBoostsLeft > 0) {
      boostFree = true;
      paymentRequired = false;
      boostsRemaining = subscription.freeOrderBoostsLeft - 1;
    } else if (subscription && (subscription.freeOrderBoostsLimit > 0 || isPro || isStandard)) {
      // Ma pakiet ale wyczerpał limity - wymagana płatność
      paymentRequired = true;
      boostsRemaining = 0;
    }
    
    // Jeśli wymagana płatność, utwórz Payment Intent
    if (paymentRequired) {
      const Payment = require('../models/Payment');
      const Stripe = require('stripe');
      const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
      
      if (!stripe) {
        return res.status(500).json({ message: 'Płatności nie są skonfigurowane' });
      }
      
      // Utwórz Payment Intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: paymentAmount,
        currency: 'pln',
        metadata: {
          userId: userId.toString(),
          orderId: orderId,
          type: 'order_boost'
        }
      });
      
      // Zapisz płatność w bazie
      const payment = new Payment({
        user: userId,
        order: orderId,
        amount: paymentAmount,
        currency: 'pln',
        status: 'requires_payment',
        type: 'order_boost',
        stripePaymentIntentId: paymentIntent.id
      });
      await payment.save();
      
      // Zaktualizuj zlecenie
      const now = new Date();
      const boostUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 godziny
      
      order.boostedAt = now;
      order.boostedUntil = boostUntil;
      order.lastBoostedAt = now;
      order.boostCount = (order.boostCount || 0) + 1;
      order.boostPaymentId = payment._id;
      order.boostFree = false;
      await order.save();
      
      return res.json({
        success: true,
        requiresPayment: true,
        paymentIntent: {
          clientSecret: paymentIntent.client_secret,
          id: paymentIntent.id
        },
        boostedUntil: boostUntil,
        boostsRemaining: boostsRemaining
      });
    } else {
      // Darmowe podbicie - odlicz limit
      const now = new Date();
      const boostUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 godziny
      
      if (subscription && subscription.freeOrderBoostsLeft > 0) {
        subscription.freeOrderBoostsLeft -= 1;
        await subscription.save();
      }
      
      order.boostedAt = now;
      order.boostedUntil = boostUntil;
      order.lastBoostedAt = now;
      order.boostCount = (order.boostCount || 0) + 1;
      order.boostFree = true;
      await order.save();
      
      return res.json({
        success: true,
        requiresPayment: false,
        boostedUntil: boostUntil,
        boostsRemaining: boostsRemaining,
        message: isPro 
          ? `Zlecenie podbite darmowo (pakiet PRO) • Pozostało ${boostsRemaining} podbić` 
          : `Zlecenie podbite darmowo (pakiet STANDARD) • Pozostało ${boostsRemaining} podbić`
      });
    }
  } catch (error) {
    console.error('Boost order error:', error);
    res.status(500).json({ message: 'Błąd podbijania zlecenia', error: error.message });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // Filtruj zlecenia użytkownika
    const filter = { $or: [{ client: userId }, { provider: userId }] };

    // Provider powinien widzieć też zlecenia, gdzie złożył ofertę (nawet jeśli nie jest jeszcze przypisany jako provider)
    if (req.user?.role === 'provider') {
      try {
        const Offer = require('../models/Offer');
        const offerOrderIds = await Offer.distinct('orderId', { providerId: userId });
        if (Array.isArray(offerOrderIds) && offerOrderIds.length > 0) {
          filter.$or.push({ _id: { $in: offerOrderIds } });
        }
      } catch (e) {
        console.error('My orders (provider offers) error:', e);
      }
    }
    
    if (status && status !== 'all') {
      // UX: "Otwarte" powinno obejmować także etap zbierania ofert
      if (status === 'open') {
        filter.status = { $in: ['open', 'collecting_offers'] };
      } else {
        filter.status = status;
      }
    }

    const orders = await Order.find(filter)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    const total = await Order.countDocuments(filter);

    res.json({
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });

  } catch (error) {
    console.error('My orders error:', error);
    res.status(500).json({ message: 'Błąd pobierania zleceń' });
  }
});

// POST /api/orders/:id/dispute - zgłoszenie sporu
router.post('/:id/dispute', auth, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    const { reason } = req.body;
    
    // Sprawdź czy użytkownik ma uprawnienia (klient lub provider)
    const isClient = String(order.client) === String(req.user._id);
    const isProvider = order.provider && String(order.provider) === String(req.user._id);
    
    if (!isClient && !isProvider) {
      return res.status(403).json({ message: 'Brak uprawnień do tego zlecenia' });
    }
    
    // Sprawdź czy można zgłosić spór
    if (!['funded', 'in_progress', 'completed'].includes(order.status)) {
      return res.status(400).json({ message: 'Nie można zgłosić sporu dla tego zlecenia' });
    }
    
    // Aktualizuj zlecenie
    order.disputeStatus = 'reported';
    order.disputeReason = reason || '';
    order.disputeReportedBy = req.user._id;
    order.disputeReportedAt = new Date();
    order.status = 'disputed';
    await order.save();
    
    // Wyślij powiadomienia o sporze
    try {
      await NotificationService.notifyOrderDisputed(order._id, reason);
    } catch (error) {
      console.error('Notification error:', error);
    }
    
    res.json({ message: 'Spór został zgłoszony', order });
  } catch (error) {
    console.error('Report dispute error:', error);
    res.status(500).json({ message: 'Błąd zgłaszania sporu' });
  }
});

// POST /api/orders/:id/refund-request - wniosek o zwrot
router.post('/:id/refund-request', auth, loadOrderById, async (req, res) => {
  try {
    const order = req.order;
    
    // Tylko klient może poprosić o zwrot
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może poprosić o zwrot' });
    }
    
    // Sprawdź czy można poprosić o zwrot
    if (order.status !== 'funded') {
      return res.status(400).json({ message: 'Zwrot możliwy tylko dla opłaconych zleceń' });
    }
    
    // Aktualizuj zlecenie
    order.refundRequested = true;
    order.refundRequestedAt = new Date();
    order.disputeStatus = 'refund_requested';
    order.status = 'disputed';
    await order.save();
    
    res.json({ message: 'Wniosek o zwrot został złożony', order });
  } catch (error) {
    console.error('Refund request error:', error);
    res.status(500).json({ message: 'Błąd składania wniosku o zwrot' });
  }
});

// POST /api/orders/:id/cancel - anulowanie zlecenia przez klienta
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie istnieje' });
    }
    
    // Sprawdź uprawnienia - tylko klient może anulować
    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Brak uprawnień do anulowania tego zlecenia' });
    }
    
    // Sprawdź czy zlecenie może być anulowane (tylko status "open")
    if (order.status !== 'open') {
      return res.status(400).json({ 
        message: `Nie można anulować zlecenia ze statusem: ${order.status}. Można anulować tylko zlecenia otwarte.` 
      });
    }
    
    // Sprawdź czy nie ma już zaakceptowanych ofert
    const Offer = require('../models/Offer');
    const acceptedOffer = await Offer.findOne({ 
      orderId: order._id, 
      status: 'accepted' 
    });
    
    if (acceptedOffer) {
      return res.status(400).json({ 
        message: 'Nie można anulować zlecenia z zaakceptowaną ofertą' 
      });
    }
    
    // Anuluj zlecenie
    order.status = 'cancelled';
    await order.save();
    
    // Odrzuć wszystkie oferty dla tego zlecenia
    await Offer.updateMany(
      { orderId: order._id, status: 'submitted' },
      { $set: { status: 'rejected' } }
    );
    
    // Powiadom providerów o anulowaniu (opcjonalnie)
    const io = req.app.get("io");
    if (io) {
      io.to(`order:${order._id}`).emit("order:cancelled", {
        orderId: String(order._id),
        clientId: String(order.client),
      });
    }
    
    res.json({ 
      message: 'Zlecenie zostało anulowane',
      order 
    });
  } catch (e) {
    console.error('Cancel order error:', e);
    res.status(500).json({ message: 'Błąd anulowania zlecenia' });
  }
});

// POST /api/orders/manage-expiration - zarządzanie wygasaniem przez AI (można wywołać z cron jobu)
// Może być wywołane bez autoryzacji jeśli jest secret token, lub z autoryzacją admin
router.post('/manage-expiration', async (req, res) => {
  try {
    // Sprawdź secret token (dla cron jobów) lub autoryzację admin
    const secretToken = req.headers['x-cron-secret'] || req.query.secret;
    const expectedSecret = process.env.CRON_SECRET || 'change-me-in-production';
    
    // Jeśli nie ma secret token, sprawdź czy użytkownik jest zalogowany jako admin
    if (!secretToken || secretToken !== expectedSecret) {
      // Sprawdź autoryzację przez req.user (ustawione przez auth middleware jeśli jest)
      if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
        return res.status(403).json({ message: 'Brak uprawnień - wymagany secret token lub autoryzacja admin' });
      }
    }
    
    const { manageOrderExpiration } = require('../utils/orderExpirationAI');
    const result = await manageOrderExpiration();
    
    res.json({
      success: true,
      message: 'Zarządzanie wygasaniem zakończone',
      ...result
    });
  } catch (error) {
    console.error('Error in manage-expiration:', error);
    res.status(500).json({ 
      success: false,
      message: 'Błąd zarządzania wygasaniem',
      error: error.message 
    });
  }
});

module.exports = router;