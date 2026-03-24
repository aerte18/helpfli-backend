const express = require("express");
const { authMiddleware: auth } = require("../../middleware/authMiddleware");
const Announcement = require("../../models/Announcement");
const User = require("../../models/User");

const router = express.Router();

// Wszystkie endpointy wymagają autoryzacji admina
router.use(auth);
router.use((req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: "Tylko administratorzy mają dostęp" });
  }
  next();
});

// GET /api/admin/announcements - lista wszystkich ogłoszeń (z filtrami)
router.get("/", async (req, res) => {
  try {
    const { status, type, search, page = 1, limit = 50 } = req.query;
    
    let query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { 'externalCompany.name': { $regex: search, $options: 'i' } }
      ];
    }
    
    const announcements = await Announcement.find(query)
      .populate('provider', 'name email phone')
      .populate('moderation.reviewedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .lean();
    
    const total = await Announcement.countDocuments(query);
    
    res.json({
      announcements,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ error: "Błąd pobierania ogłoszeń" });
  }
});

// GET /api/admin/announcements/pending - lista oczekujących na akceptację
router.get("/pending", async (req, res) => {
  try {
    const announcements = await Announcement.find({ status: 'pending' })
      .populate('provider', 'name email phone')
      .sort({ createdAt: 1 }) // Najstarsze pierwsze
      .lean();
    
    res.json({ announcements, count: announcements.length });
  } catch (error) {
    console.error('Error fetching pending announcements:', error);
    res.status(500).json({ error: "Błąd pobierania oczekujących ogłoszeń" });
  }
});

// POST /api/admin/announcements/:id/approve - akceptacja ogłoszenia
router.post("/:id/approve", async (req, res) => {
  try {
    const { notes, featuredUntil, promotionType } = req.body;
    const announcement = await Announcement.findById(req.params.id);
    
    if (!announcement) {
      return res.status(404).json({ error: "Ogłoszenie nie znalezione" });
    }
    
    // Sprawdź czy płatność została dokonana (dla zewnętrznych i nie-PRO)
    if (announcement.isExternal || announcement.payment.status !== 'paid') {
      // Dla zewnętrznych - sprawdź czy zapłacili
      if (announcement.payment.status !== 'paid') {
        return res.status(400).json({ 
          error: "Nie można zaakceptować - płatność nie została dokonana",
          requiresPayment: true,
          paymentAmount: announcement.payment.amount
        });
      }
    }
    
    // Akceptuj ogłoszenie
    announcement.status = 'active';
    announcement.moderation = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      notes: notes || ''
    };
    
    // Jeśli admin ustawił featured/promocję
    if (featuredUntil) {
      announcement.featured = true;
      announcement.featuredUntil = new Date(featuredUntil);
    }
    
    if (promotionType && promotionType !== 'none') {
      announcement.promotion.type = promotionType;
      announcement.promotion.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dni
    }
    
    await announcement.save();
    
    res.json({ 
      message: "Ogłoszenie zostało zaakceptowane",
      announcement 
    });
  } catch (error) {
    console.error('Error approving announcement:', error);
    res.status(500).json({ error: "Błąd akceptacji ogłoszenia" });
  }
});

// POST /api/admin/announcements/:id/reject - odrzucenie ogłoszenia
router.post("/:id/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    const announcement = await Announcement.findById(req.params.id);
    
    if (!announcement) {
      return res.status(404).json({ error: "Ogłoszenie nie znalezione" });
    }
    
    if (!reason) {
      return res.status(400).json({ error: "Podaj powód odrzucenia" });
    }
    
    announcement.status = 'rejected';
    announcement.moderation = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      rejectionReason: reason
    };
    
    await announcement.save();
    
    // TODO: Wyślij email do właściciela ogłoszenia z powodem odrzucenia
    
    res.json({ 
      message: "Ogłoszenie zostało odrzucone",
      announcement 
    });
  } catch (error) {
    console.error('Error rejecting announcement:', error);
    res.status(500).json({ error: "Błąd odrzucania ogłoszenia" });
  }
});

// POST /api/admin/announcements - ręczne dodanie ogłoszenia przez admina
router.post("/", async (req, res) => {
  try {
    const {
      externalCompany,
      type,
      category,
      title,
      description,
      price,
      location,
      promotionType = 'none',
      featuredUntil,
      autoApprove = true // Admin może od razu zaakceptować
    } = req.body;
    
    // Walidacja
    if (!type || !category || !title || !description || !price || !location) {
      return res.status(400).json({ error: "Wypełnij wszystkie wymagane pola" });
    }
    
    const announcement = await Announcement.create({
      isExternal: !!externalCompany,
      externalCompany: externalCompany || undefined,
      provider: externalCompany ? undefined : req.body.providerId,
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
      contactPhone: externalCompany?.phone || req.body.contactPhone,
      contactEmail: externalCompany?.email || req.body.contactEmail,
      status: autoApprove ? 'active' : 'pending',
      payment: {
        status: 'paid', // Admin dodaje = już opłacone
        amount: 0, // Może być negocjowane
        paidAt: new Date()
      },
      promotion: {
        type: promotionType,
        expiresAt: promotionType !== 'none' 
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          : undefined
      },
      featured: !!featuredUntil,
      featuredUntil: featuredUntil ? new Date(featuredUntil) : undefined,
      moderation: {
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        notes: req.body.adminNotes || 'Dodane ręcznie przez admina'
      }
    });
    
    res.status(201).json(announcement);
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ error: "Błąd tworzenia ogłoszenia" });
  }
});

// GET /api/admin/announcements/stats - statystyki ogłoszeń
router.get("/stats", async (req, res) => {
  try {
    const stats = {
      total: await Announcement.countDocuments(),
      pending: await Announcement.countDocuments({ status: 'pending' }),
      active: await Announcement.countDocuments({ status: 'active' }),
      rejected: await Announcement.countDocuments({ status: 'rejected' }),
      external: await Announcement.countDocuments({ isExternal: true }),
      byType: {
        equipment_rental: await Announcement.countDocuments({ type: 'equipment_rental' }),
        parts_sale: await Announcement.countDocuments({ type: 'parts_sale' }),
        service: await Announcement.countDocuments({ type: 'service' }),
        other: await Announcement.countDocuments({ type: 'other' })
      },
      revenue: {
        total: await Announcement.aggregate([
          { $match: { 'payment.status': 'paid' } },
          { $group: { _id: null, total: { $sum: '$payment.amount' } } }
        ]).then(r => r[0]?.total || 0),
        thisMonth: await Announcement.aggregate([
          { 
            $match: { 
              'payment.status': 'paid',
              'payment.paidAt': { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
            }
          },
          { $group: { _id: null, total: { $sum: '$payment.amount' } } }
        ]).then(r => r[0]?.total || 0)
      }
    };
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: "Błąd pobierania statystyk" });
  }
});

module.exports = router;










