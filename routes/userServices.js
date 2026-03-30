const express = require('express');
const { auth } = require('../middleware/auth');
const Service = require('../models/Service');
const User = require('../models/User');
const path = require('path');
const router = express.Router();

let STATIC_CATALOG = [];
try {
  const candidates = [
    path.join(__dirname, '..', 'services_catalog.json'),
    path.join(__dirname, '..', 'data', 'services_catalog.json'),
    path.join(__dirname, '..', '..', 'services_catalog.json'),
  ];
  for (const p of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const data = require(p);
      if (Array.isArray(data) && data.length > 0) {
        STATIC_CATALOG = data;
        break;
      }
    } catch (_) {
      // next candidate
    }
  }
} catch (_) {
  STATIC_CATALOG = [];
}

function escapeRegex(input = '') {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Kompatybilność wsteczna:
 * starsze konta mogły mieć tylko pole `user.service` (string), bez `user.services` (ObjectId[]).
 * Przy pierwszym odczycie próbujemy zmapować i zapisać brakującą usługę.
 */
async function migrateLegacyUserServiceIfNeeded(user) {
  if (!user) return user;
  if (Array.isArray(user.services) && user.services.length > 0) return user;

  const legacyRaw =
    (typeof user.service === 'string' && user.service.trim()) ||
    (typeof user.serviceType === 'string' && user.serviceType.trim()) ||
    '';
  if (!legacyRaw) return user;

  const legacy = legacyRaw.trim();
  const bySlug = await Service.findOne({ slug: legacy.toLowerCase() }).select('_id');
  let matched = bySlug;
  if (!matched) {
    const re = new RegExp(`^${escapeRegex(legacy)}$`, 'i');
    matched = await Service.findOne({
      $or: [{ name_pl: re }, { name_en: re }, { name: re }],
    }).select('_id');
  }
  if (!matched?._id) return user;

  user.services = [matched._id];
  await user.save();
  return User.findById(user._id).populate('services');
}

function normalizeSlug(v = '') {
  return String(v).trim().toLowerCase().replace(/_/g, '-');
}

async function resolveServiceByIdOrSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  // ObjectId
  if (/^[a-f0-9]{24}$/i.test(raw)) {
    const byId = await Service.findById(raw);
    if (byId) return byId;
  }

  const normalized = normalizeSlug(raw);
  const underscored = normalized.replace(/-/g, '_');
  const variants = [...new Set([raw, raw.toLowerCase(), normalized, underscored])].filter(Boolean);

  let doc = await Service.findOne({ slug: { $in: variants } });
  if (doc) return doc;

  // Fallback po nazwie (legacy wpisy)
  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escapeRegex(raw)}$`, 'i');
  doc = await Service.findOne({ $or: [{ name_pl: re }, { name_en: re }] });
  if (doc) return doc;

  // Fallback: jeśli slug istnieje tylko w statycznym katalogu, utwórz rekord w DB.
  if (Array.isArray(STATIC_CATALOG) && STATIC_CATALOG.length > 0) {
    const normalizedSet = new Set(variants.map((v) => normalizeSlug(v)));
    const staticHit = STATIC_CATALOG.find((s) => {
      const sSlug = normalizeSlug(s?.slug || '');
      if (sSlug && normalizedSet.has(sSlug)) return true;
      const sNamePl = String(s?.name_pl || '').trim().toLowerCase();
      const sNameEn = String(s?.name_en || '').trim().toLowerCase();
      const rawNorm = String(raw || '').trim().toLowerCase();
      return rawNorm && (sNamePl === rawNorm || sNameEn === rawNorm);
    });

    if (staticHit?.slug) {
      const slug = normalizeSlug(staticHit.slug);
      const payload = {
        parent_slug: String(staticHit.parent_slug || slug.split('-')[0] || 'inne').toLowerCase(),
        slug,
        name_pl: staticHit.name_pl || staticHit.name || slug,
        name_en: staticHit.name_en || staticHit.name_pl || staticHit.name || slug,
        description: staticHit.description || staticHit.name_pl || staticHit.name || slug,
        tags: staticHit.tags || '',
        intent_keywords: staticHit.intent_keywords || '',
        service_kind: staticHit.service_kind || 'onsite',
        urgency_level: Number(staticHit.urgency_level) || 3,
        is_top: Number(staticHit.is_top) || 0,
        seasonal: staticHit.seasonal || 'none',
      };
      doc = await Service.findOneAndUpdate(
        { slug },
        { $setOnInsert: payload },
        { new: true, upsert: true }
      );
      if (doc) return doc;
    }
  }

  return null;
}

// Pobierz usługi przypisane do użytkownika
router.get('/', auth, async (req, res) => {
  let user = await User.findById(req.user._id).populate('services');
  user = await migrateLegacyUserServiceIfNeeded(user);
  res.json(user?.services || []);
});

// Pobierz usługi konkretnego providera (publiczny endpoint)
router.get('/provider/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const user = await User.findById(providerId).populate('services');
    
    if (!user) {
      return res.status(404).json({ message: 'Wykonawca nie został znaleziony' });
    }
    
    // Zwróć tylko usługi (bez innych danych użytkownika)
    res.json(user.services || []);
  } catch (err) {
    console.error('Błąd pobierania usług wykonawcy:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Dodaj usługi użytkownikowi (obsługa tablicy)
router.post('/', auth, async (req, res) => {
  const { services } = req.body;

  if (!services || !Array.isArray(services)) {
    return res.status(400).json({ message: 'Brak tablicy usług' });
  }

  const user = await User.findById(req.user._id);
  
  // Sprawdź czy wszystkie usługi istnieją
  for (const serviceId of services) {
    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ message: `Nie znaleziono usługi: ${serviceId}` });
    }
  }

  // Ustaw usługi (zastąp istniejące)
  user.services = services;
  await user.save();

  // Pobierz zaktualizowane usługi z populate
  const updatedUser = await User.findById(req.user._id).populate('services');
  res.json({ message: 'Usługi zaktualizowane', services: updatedUser.services });
});

// Dodaj pojedynczą usługę użytkownikowi
router.post('/add/:serviceId', auth, async (req, res) => {
  const { serviceId } = req.params;

  const user = await User.findById(req.user._id);
  
  // Sprawdź czy usługa istnieje (ObjectId lub slug)
  const service = await resolveServiceByIdOrSlug(serviceId);
  if (!service) {
    return res.status(404).json({ message: `Nie znaleziono usługi: ${serviceId}` });
  }

  // Sprawdź czy użytkownik już ma tę usługę
  const sid = String(service._id);
  if ((user.services || []).some((id) => String(id) === sid)) {
    return res.status(400).json({ message: 'Użytkownik już ma tę usługę' });
  }

  // Dodaj usługę
  user.services.push(service._id);
  await user.save();

  // Pobierz zaktualizowane usługi z populate
  const updatedUser = await User.findById(req.user._id).populate('services');
  res.json({ message: 'Usługa dodana', services: updatedUser.services });
});

// Usuń usługę użytkownikowi
router.delete('/:serviceId', auth, async (req, res) => {
  const { serviceId } = req.params;

  const user = await User.findById(req.user._id);
  const service = await resolveServiceByIdOrSlug(serviceId);
  if (!service) {
    return res.status(404).json({ message: `Nie znaleziono usługi: ${serviceId}` });
  }
  const sid = String(service._id);
  user.services = (user.services || []).filter((id) => String(id) !== sid);
  await user.save();

  // Pobierz zaktualizowane usługi z populate
  const updatedUser = await User.findById(req.user._id).populate('services');
  res.json({ message: 'Usługa usunięta', services: updatedUser.services });
});

module.exports = router;