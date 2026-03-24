const express = require("express");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Announcement = require("../models/Announcement");
const User = require("../models/User");

const router = express.Router();

// Funkcja do obliczania ceny ogłoszenia
function calculateAnnouncementPrice(promotionType = 'none', durationDays = 30) {
  const basePrice = 5000; // 50 zł za 30 dni (w groszach)
  const pricePerDay = basePrice / 30;
  let totalPrice = pricePerDay * durationDays;
  
  // Dodatkowe koszty za promocje
  switch (promotionType) {
    case 'featured':
      totalPrice += 2000; // +20 zł
      break;
    case 'top':
      totalPrice += 5000; // +50 zł
      break;
    case 'premium':
      totalPrice += 10000; // +100 zł
      break;
  }
  
  return Math.round(totalPrice);
}

// GET /api/announcements - lista ogłoszeń (publiczna)
router.get("/", async (req, res) => {
  try {
    const {
      type,
      category,
      search,
      lat,
      lng,
      maxDistance,
      minPrice,
      maxPrice,
      tags,
      featured,
      limit = 50,
      skip = 0
    } = req.query;

    let query = { status: 'active', availability: 'available' }; // Tylko zaakceptowane przez admina

    // Filtry
    if (type) query.type = type;
    if (category) query.category = category;
    if (featured === 'true') query.featured = true;
    if (minPrice) query.price = { ...query.price, $gte: Number(minPrice) };
    if (maxPrice) query.price = { ...query.price, $lte: Number(maxPrice) };
    if (tags) {
      const tagsArray = Array.isArray(tags) ? tags : tags.split(',');
      query.tags = { $in: tagsArray };
    }

    // Wyszukiwanie tekstowe
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } }
      ];
    }

    let announcements = await Announcement.find(query)
      .populate('provider', 'name avatar ratingAvg badges location')
      .sort({ featured: -1, createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(skip))
      .lean();

    // Filtrowanie po dystansie (jeśli podano koordynaty)
    if (lat && lng && maxDistance) {
      const userLat = Number(lat);
      const userLng = Number(lng);
      const maxDist = Number(maxDistance);

      announcements = announcements.filter(ann => {
        if (!ann.locationLat || !ann.locationLon) return false;
        const distance = calculateDistance(
          userLat, userLng,
          ann.locationLat, ann.locationLon
        );
        return distance <= maxDist;
      });

      // Dodaj informację o dystansie
      announcements = announcements.map(ann => ({
        ...ann,
        distanceKm: calculateDistance(
          userLat, userLng,
          ann.locationLat, ann.locationLon
        )
      }));

      // Sortuj po dystansie
      announcements.sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
    }

    res.json({
      announcements,
      total: announcements.length,
      limit: Number(limit),
      skip: Number(skip)
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ error: "Błąd pobierania ogłoszeń" });
  }
});

// GET /api/announcements/search - wyszukiwanie dla AI Concierge
router.get("/search", async (req, res) => {
  try {
    const { query: searchQuery, category, type, lat, lng, maxDistance = 50 } = req.query;

    if (!searchQuery) {
      return res.json({ announcements: [] });
    }

    // Buduj query z wyszukiwaniem semantycznym
    const query = {
      status: 'active',
      availability: 'available',
      $or: [
        { title: { $regex: searchQuery, $options: 'i' } },
        { description: { $regex: searchQuery, $options: 'i' } },
        { tags: { $regex: searchQuery, $options: 'i' } }
      ]
    };

    if (category) query.category = category;
    if (type) query.type = type;

    let announcements = await Announcement.find(query)
      .populate('provider', 'name avatar ratingAvg badges location')
      .sort({ featured: -1, views: -1 })
      .limit(10)
      .lean();

    // Filtrowanie po dystansie
    if (lat && lng) {
      const userLat = Number(lat);
      const userLng = Number(lng);

      announcements = announcements
        .filter(ann => {
          if (!ann.locationLat || !ann.locationLon) return false;
          const distance = calculateDistance(
            userLat, userLng,
            ann.locationLat, ann.locationLon
          );
          return distance <= Number(maxDistance);
        })
        .map(ann => ({
          ...ann,
          distanceKm: calculateDistance(
            userLat, userLng,
            ann.locationLat, ann.locationLon
          )
        }))
        .sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
    }

    res.json({ announcements });
  } catch (error) {
    console.error('Error searching announcements:', error);
    res.status(500).json({ error: "Błąd wyszukiwania ogłoszeń" });
  }
});

// GET /api/announcements/:id - szczegóły ogłoszenia
router.get("/:id", async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id)
      .populate('provider', 'name avatar ratingAvg badges location phone email')
      .lean();

    if (!announcement) {
      return res.status(404).json({ error: "Ogłoszenie nie znalezione" });
    }

    // Zwiększ licznik wyświetleń
    await Announcement.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.json(announcement);
  } catch (error) {
    console.error('Error fetching announcement:', error);
    res.status(500).json({ error: "Błąd pobierania ogłoszenia" });
  }
});

// POST /api/announcements - utworzenie ogłoszenia (providerzy + firmy zewnętrzne)
router.post("/", async (req, res) => {
  try {
    const isAuthenticated = req.headers.authorization;
    const isExternal = req.body.isExternal === true;
    
    // Jeśli zewnętrzne, nie wymagaj autoryzacji, ale wymagaj danych firmy
    if (isExternal) {
      const { externalCompany, type, category, title, description, price, location } = req.body;
      if (!externalCompany?.name || !externalCompany?.email || !type || !category || !title || !description || !price || !location) {
        return res.status(400).json({ error: "Wypełnij wszystkie wymagane pola (w tym dane firmy)" });
      }
      
      // Utworzenie ogłoszenia zewnętrznego - wymaga płatności
      const announcement = await Announcement.create({
        isExternal: true,
        externalCompany: {
          name: externalCompany.name,
          email: externalCompany.email,
          phone: externalCompany.phone,
          website: externalCompany.website,
          address: externalCompany.address
        },
        type,
        category,
        title,
        description,
        price: Math.round(Number(price) * 100),
        priceType: req.body.priceType || 'one_time',
        location,
        locationLat: req.body.locationLat ? Number(req.body.locationLat) : undefined,
        locationLon: req.body.locationLon ? Number(req.body.locationLon) : undefined,
        images: req.body.images || [],
        tags: req.body.tags || [],
        equipmentDetails: req.body.equipmentDetails || {},
        partsDetails: req.body.partsDetails || {},
        contactPhone: externalCompany.phone,
        contactEmail: externalCompany.email,
        status: 'pending', // Wymaga akceptacji admina + płatności
        payment: {
          status: 'pending',
          amount: calculateAnnouncementPrice(req.body.promotion?.type || 'none', req.body.duration || 30), // 30 dni domyślnie
          expiresAt: new Date(Date.now() + (req.body.duration || 30) * 24 * 60 * 60 * 1000)
        },
        promotion: {
          type: req.body.promotion?.type || 'none',
          expiresAt: req.body.promotion?.type && req.body.promotion?.type !== 'none' 
            ? new Date(Date.now() + (req.body.promotion?.duration || 7) * 24 * 60 * 60 * 1000)
            : undefined
        }
      });
      
      // Zwróć ogłoszenie z informacją o potrzebie płatności
      return res.status(201).json({
        announcement,
        requiresPayment: true,
        paymentAmount: announcement.payment.amount,
        checkoutUrl: `/checkout?reason=announcement&announcementId=${announcement._id}&amount=${announcement.payment.amount}`
      });
    }
    
    // Dla zalogowanych providerów - użyj middleware auth
    // Musimy użyć wrappera, bo auth jest middleware
    return auth(async (req, res) => {
      if (req.user.role !== 'provider' && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Tylko wykonawcy mogą dodawać ogłoszenia" });
      }
      
      const {
        type,
        category,
        title,
        description,
        price,
        priceType,
        location,
        locationLat,
        locationLon,
        images,
        tags,
        equipmentDetails,
        partsDetails,
        contactPhone,
        contactEmail
      } = req.body;

      // Walidacja
      if (!type || !category || !title || !description || !price || !location) {
        return res.status(400).json({ error: "Wypełnij wszystkie wymagane pola" });
      }

      // Oblicz cenę ogłoszenia (dla providerów może być darmowe w pakiecie PRO)
      const UserSubscription = require('../models/UserSubscription');
      const subscription = await UserSubscription.findOne({ 
        user: req.user._id,
        validUntil: { $gt: new Date() }
      });
      const isPro = subscription?.planKey === 'PROVIDER_PRO';
      const announcementPrice = isPro ? 0 : calculateAnnouncementPrice(req.body.promotion?.type || 'none', req.body.duration || 30);
      
      const announcement = await Announcement.create({
        provider: req.user._id,
        isExternal: false,
        type,
        category,
        title,
        description,
        price: Math.round(Number(price) * 100), // konwersja na grosze
        priceType: priceType || 'one_time',
        location,
        locationLat: locationLat ? Number(locationLat) : undefined,
        locationLon: locationLon ? Number(locationLon) : undefined,
        images: images || [],
        tags: tags || [],
        equipmentDetails: equipmentDetails || {},
        partsDetails: partsDetails || {},
        contactPhone: contactPhone || req.user.phone,
        contactEmail: contactEmail || req.user.email,
        status: 'pending', // Wszystkie wymagają akceptacji admina (nawet PRO)
        payment: {
          status: announcementPrice === 0 ? 'paid' : 'pending',
          amount: announcementPrice,
          expiresAt: new Date(Date.now() + (req.body.duration || 30) * 24 * 60 * 60 * 1000)
        },
        promotion: {
          type: req.body.promotion?.type || 'none',
          expiresAt: req.body.promotion?.type && req.body.promotion?.type !== 'none' 
            ? new Date(Date.now() + (req.body.promotion?.duration || 7) * 24 * 60 * 60 * 1000)
            : undefined
        }
      });

      if (announcementPrice > 0) {
        return res.status(201).json({
          announcement,
          requiresPayment: true,
          paymentAmount: announcementPrice,
          checkoutUrl: `/checkout?reason=announcement&announcementId=${announcement._id}&amount=${announcementPrice}`
        });
      }

      res.status(201).json(announcement);
    })(req, res);
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ error: "Błąd tworzenia ogłoszenia" });
  }
});

// PUT /api/announcements/:id - aktualizacja ogłoszenia
router.put("/:id", auth, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);

    if (!announcement) {
      return res.status(404).json({ error: "Ogłoszenie nie znalezione" });
    }

    // Sprawdź czy użytkownik jest właścicielem
    if (announcement.provider.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Brak uprawnień" });
    }

    const updates = req.body;
    if (updates.price) updates.price = Math.round(Number(updates.price) * 100);

    Object.assign(announcement, updates);
    await announcement.save();

    res.json(announcement);
  } catch (error) {
    console.error('Error updating announcement:', error);
    res.status(500).json({ error: "Błąd aktualizacji ogłoszenia" });
  }
});

// DELETE /api/announcements/:id - usunięcie ogłoszenia
router.delete("/:id", auth, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);

    if (!announcement) {
      return res.status(404).json({ error: "Ogłoszenie nie znalezione" });
    }

    // Sprawdź czy użytkownik jest właścicielem
    if (announcement.provider.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Brak uprawnień" });
    }

    announcement.status = 'archived';
    await announcement.save();

    res.json({ message: "Ogłoszenie zostało usunięte" });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({ error: "Błąd usuwania ogłoszenia" });
  }
});

// GET /api/announcements/my - moje ogłoszenia (provider)
router.get("/my", auth, async (req, res) => {
  try {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: "Tylko wykonawcy mogą przeglądać swoje ogłoszenia" });
    }

    const announcements = await Announcement.find({ provider: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ announcements });
  } catch (error) {
    console.error('Error fetching my announcements:', error);
    res.status(500).json({ error: "Błąd pobierania ogłoszeń" });
  }
});

// POST /api/announcements/:id/inquire - zapytanie o ogłoszenie
router.post("/:id/inquire", auth, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);

    if (!announcement) {
      return res.status(404).json({ error: "Ogłoszenie nie znalezione" });
    }

    // Zwiększ licznik zapytań
    await Announcement.findByIdAndUpdate(req.params.id, { $inc: { inquiries: 1 } });

    // Tutaj można dodać logikę wysyłania wiadomości do providera
    // np. utworzenie wiadomości w systemie czatu

    res.json({ message: "Zapytanie zostało wysłane" });
  } catch (error) {
    console.error('Error inquiring announcement:', error);
    res.status(500).json({ error: "Błąd wysyłania zapytania" });
  }
});

// Funkcja pomocnicza do obliczania dystansu
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Promień Ziemi w km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

module.exports = router;

