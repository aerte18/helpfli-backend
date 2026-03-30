const express = require('express');
const { auth } = require('../middleware/auth');
const Service = require('../models/Service');
const User = require('../models/User');
const router = express.Router();

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
  
  // Sprawdź czy usługa istnieje
  const service = await Service.findById(serviceId);
  if (!service) {
    return res.status(404).json({ message: `Nie znaleziono usługi: ${serviceId}` });
  }

  // Sprawdź czy użytkownik już ma tę usługę
  if (user.services.includes(serviceId)) {
    return res.status(400).json({ message: 'Użytkownik już ma tę usługę' });
  }

  // Dodaj usługę
  user.services.push(serviceId);
  await user.save();

  // Pobierz zaktualizowane usługi z populate
  const updatedUser = await User.findById(req.user._id).populate('services');
  res.json({ message: 'Usługa dodana', services: updatedUser.services });
});

// Usuń usługę użytkownikowi
router.delete('/:serviceId', auth, async (req, res) => {
  const { serviceId } = req.params;

  const user = await User.findById(req.user._id);
  user.services = user.services.filter((id) => id.toString() !== serviceId);
  await user.save();

  // Pobierz zaktualizowane usługi z populate
  const updatedUser = await User.findById(req.user._id).populate('services');
  res.json({ message: 'Usługa usunięta', services: updatedUser.services });
});

module.exports = router;