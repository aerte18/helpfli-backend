?const express = require('express');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/authMiddleware');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// Konfiguracja multer dla zdjęć profilowych
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/avatars');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Nazwa pliku: userId_timestamp.extension
    const ext = path.extname(file.originalname);
    const filename = `${req.user._id}_${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Tylko pliki obrazów (JPEG, PNG, GIF, WebP) są dozwolone'));
    }
  }
});

// PUT /api/users/me/billing - zaktualizuj dane do faktury
router.put("/me/billing", authMiddleware, async (req, res) => {
  try {
    const {
      wantInvoice,
      companyName,
      nip,
      street,
      city,
      postalCode,
      country,
      customerType,
      invoiceMode
    } = req.body || {};

    const update = {
      'billing.wantInvoice': !!wantInvoice,
      'billing.companyName': companyName || '',
      'billing.nip': nip || '',
      'billing.street': street || '',
      'billing.city': city || '',
      'billing.postalCode': postalCode || '',
      'billing.country': country || 'Polska'
    };

    if (customerType === 'individual' || customerType === 'company') {
      update['billing.customerType'] = customerType;
    }
    if (invoiceMode === 'per_order' || invoiceMode === 'monthly') {
      update['billing.invoiceMode'] = invoiceMode;
    }

    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ ok: true, message: 'Dane do faktury zaktualizowane' });
  } catch (err) {
    console.error('UPDATE_BILLING_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// PUT /api/users/me/availability
router.put("/me/availability", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { availability: req.body.availability });
    res.json({ ok: true });
  } catch (err) {
    console.error('UPDATE_AVAILABILITY_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// PATCH /api/users/me - ogólna aktualizacja profilu użytkownika
router.patch("/me", authMiddleware, async (req, res) => {
  try {
    const allowedFields = ['providerPaymentPreference', 'name', 'phone', 'location', 'address', 'isB2B', 'b2b'];
    const updateData = {};
    
    // Aktualizuj tylko dozwolone pola
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }
    // isB2B i b2b – tylko dla providera; przy wyłączeniu ustaw oba na false
    if (req.user.role === 'provider' && (updateData.isB2B !== undefined || updateData.b2b !== undefined)) {
      const val = updateData.isB2B !== undefined ? !!updateData.isB2B : !!updateData.b2b;
      updateData.isB2B = val;
      updateData.b2b = val;
    } else if (req.user.role !== 'provider') {
      delete updateData.isB2B;
      delete updateData.b2b;
    }
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'Brak pól do aktualizacji' });
    }
    
    await User.findByIdAndUpdate(req.user._id, updateData);
    const updatedUser = await User.findById(req.user._id).select('-password');
    res.json({ ok: true, user: updatedUser, message: 'Profil zaktualizowany' });
  } catch (err) {
    console.error('UPDATE_USER_ERROR:', err);
    res.status(500).json({ message: 'Błąd aktualizacji profilu' });
  }
});

// PUT /api/users/me/profile
router.put("/me/profile", authMiddleware, async (req, res) => {
  try {
    const { priceNote, bio, service, headline } = req.body;
    const updateData = { priceNote, bio };
    if (service) updateData.service = service;
    if (headline !== undefined) updateData.headline = headline; // Krótki nagłówek (max 60 znaków)
    await User.findByIdAndUpdate(req.user._id, updateData);
    res.json({ ok: true });
  } catch (err) {
    console.error('UPDATE_PROFILE_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// PUT /api/users/me/onboarding
router.put("/me/onboarding", authMiddleware, async (req, res) => {
  try {
    const { onboardingCompleted } = req.body;
    await User.findByIdAndUpdate(req.user._id, { onboardingCompleted: !!onboardingCompleted });
    res.json({ ok: true });
  } catch (err) {
    console.error('UPDATE_ONBOARDING_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// PUT /api/users/me/password - zmień hasło
router.put("/me/password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }
    
    const requiresPasswordChange = user.requiresPasswordChange;
    
    // Jeśli wymagana jest zmiana hasła (pierwsze logowanie), nie sprawdzaj obecnego hasła
    if (!requiresPasswordChange) {
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Podaj obecne i nowe hasło' });
      }
      
      // Sprawdź obecne hasło
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) {
        return res.status(400).json({ message: 'Nieprawidłowe obecne hasło' });
      }
    } else {
      // Wymuszona zmiana hasła - nie wymagaj obecnego hasła
      if (!newPassword) {
        return res.status(400).json({ message: 'Podaj nowe hasło' });
      }
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Nowe hasło musi mieć co najmniej 6 znaków' });
    }
    
    // Hashuj nowe hasło
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Zaktualizuj hasło i usuń flagę wymuszania zmiany
    await User.findByIdAndUpdate(req.user._id, {
      password: hashedPassword,
      requiresPasswordChange: false
    });
    
    res.json({ 
      ok: true, 
      message: requiresPasswordChange 
        ? 'Hasło zostało ustawione. Możesz teraz korzystać z konta.' 
        : 'Hasło zostało zmienione' 
    });
  } catch (err) {
    console.error('CHANGE_PASSWORD_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// GET /api/users/me/2fa - sprawdź status 2FA
router.get("/me/2fa", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('twoFactorEnabled twoFactorSecret').lean();
    res.json({ 
      enabled: user?.twoFactorEnabled || false,
      setup: !!(user?.twoFactorSecret) // Czy 2FA jest skonfigurowane (ma sekret)
    });
  } catch (err) {
    console.error('GET_2FA_STATUS_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// POST /api/users/me/2fa/setup - rozpocznij konfigurację 2FA (generuj sekret i QR)
router.post("/me/2fa/setup", authMiddleware, async (req, res) => {
  try {
    // Sprawdź czy speakeasy jest dostępne
    let speakeasy, qrcode;
    try {
      speakeasy = require('speakeasy');
      qrcode = require('qrcode');
    } catch (e) {
      return res.status(503).json({ 
        message: 'Biblioteka 2FA nie jest zainstalowana. Uruchom: npm install speakeasy qrcode',
        needsInstall: true
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    // Generuj sekret
    const secret = speakeasy.generateSecret({
      name: `Helpfli (${user.email})`,
      issuer: 'Helpfli'
    });

    // Generuj QR kod jako data URL
    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

    // ZAPISZ TYMCZASOWY SEKRET (nie aktywuj jeszcze 2FA)
    // Użytkownik musi najpierw zweryfikować kod, zanim aktywujemy 2FA
    await User.findByIdAndUpdate(req.user._id, {
      twoFactorSecret: secret.base32, // Tymczasowy sekret (zostanie potwierdzony przy weryfikacji)
      twoFactorEnabled: false // Nie aktywuj jeszcze
    });

    // Generuj kody zapasowe
    const backupCodes = Array.from({ length: 8 }, () => 
      Math.random().toString(36).substring(2, 10).toUpperCase()
    );

    res.json({
      secret: secret.base32,
      qrCode: qrCodeUrl,
      backupCodes: backupCodes, // Wyświetl użytkownikowi do zapisania
      manualEntryKey: secret.base32 // Do ręcznego wpisania w aplikacji
    });
  } catch (err) {
    console.error('SETUP_2FA_ERROR:', err);
    res.status(500).json({ message: 'Błąd konfiguracji 2FA' });
  }
});

// POST /api/users/me/2fa/verify - zweryfikuj kod i aktywuj 2FA
router.post("/me/2fa/verify", authMiddleware, async (req, res) => {
  try {
    const { token, backupCodes } = req.body;
    
    let speakeasy;
    try {
      speakeasy = require('speakeasy');
    } catch (e) {
      return res.status(503).json({ 
        message: 'Biblioteka 2FA nie jest zainstalowana',
        needsInstall: true
      });
    }

    const user = await User.findById(req.user._id);
    if (!user || !user.twoFactorSecret) {
      return res.status(400).json({ message: 'Najpierw rozpocznij konfigurację 2FA' });
    }

    // Sprawdź kod TOTP
    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: token
    });

    if (!verified) {
      return res.status(400).json({ message: 'Nieprawidłowy kod weryfikacyjny' });
    }

    // Zaszyfruj kody zapasowe (używając bcrypt lub prostego hashowania)
    const hashedBackupCodes = (backupCodes || []).map(code => 
      require('crypto').createHash('sha256').update(code).digest('hex')
    );

    // Aktywuj 2FA
    await User.findByIdAndUpdate(req.user._id, {
      twoFactorEnabled: true,
      twoFactorBackupCodes: hashedBackupCodes
    });

    res.json({ 
      ok: true, 
      message: 'Dwuskładnikowa autoryzacja została aktywowana' 
    });
  } catch (err) {
    console.error('VERIFY_2FA_ERROR:', err);
    res.status(500).json({ message: 'Błąd weryfikacji 2FA' });
  }
});

// POST /api/users/me/avatar - upload zdjęcia profilowego
router.post("/me/avatar", authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Nie wybrano pliku' });
    }

    // URL do zdjęcia (względny do /uploads)
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    
    // Zaktualizuj avatar użytkownika
    await User.findByIdAndUpdate(req.user._id, { avatar: avatarUrl });
    
    res.json({ 
      ok: true, 
      avatar: avatarUrl,
      message: 'Zdjęcie profilowe zostało zaktualizowane' 
    });
  } catch (err) {
    console.error('UPLOAD_AVATAR_ERROR:', err);
    // Usuń plik jeśli był błąd
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ message: err.message || 'Błąd podczas przesyłania zdjęcia' });
  }
});

// DELETE /api/users/me/avatar - usuń zdjęcie profilowe
router.delete("/me/avatar", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    // Usuń stary plik jeśli istnieje
    if (user.avatar && user.avatar.startsWith('/uploads/avatars/')) {
      const oldFilePath = path.join(__dirname, '..', user.avatar);
      if (fs.existsSync(oldFilePath)) {
        fs.unlink(oldFilePath, () => {});
      }
    }

    // Ustaw domyślny avatar
    await User.findByIdAndUpdate(req.user._id, { avatar: 'https://via.placeholder.com/150' });
    
    res.json({ ok: true, message: 'Zdjęcie profilowe zostało usunięte' });
  } catch (err) {
    console.error('DELETE_AVATAR_ERROR:', err);
    res.status(500).json({ message: 'Błąd podczas usuwania zdjęcia' });
  }
});

// PUT /api/users/me/2fa - włącz/wyłącz 2FA (wymaga hasła do wyłączenia)
router.put("/me/2fa", authMiddleware, async (req, res) => {
  try {
    const { enabled, password } = req.body;
    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    // Jeśli wyłączamy 2FA, wymagaj hasła
    if (!enabled && user.twoFactorEnabled) {
      if (!password) {
        return res.status(400).json({ message: 'Podaj hasło, aby wyłączyć 2FA' });
      }
      
      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(400).json({ message: 'Nieprawidłowe hasło' });
      }
    }

    // Jeśli włączamy, sprawdź czy jest skonfigurowane
    if (enabled && !user.twoFactorSecret) {
      return res.status(400).json({ message: 'Najpierw skonfiguruj 2FA (wygeneruj sekret i zweryfikuj kod)' });
    }

    await User.findByIdAndUpdate(req.user._id, { 
      twoFactorEnabled: !!enabled,
      // Jeśli wyłączamy, usuń sekret i kody zapasowe
      ...(enabled ? {} : { twoFactorSecret: null, twoFactorBackupCodes: [] })
    });
    
    res.json({ 
      ok: true, 
      message: enabled ? 'Dwuskładnikowa autoryzacja włączona' : 'Dwuskładnikowa autoryzacja wyłączona' 
    });
  } catch (err) {
    console.error('UPDATE_2FA_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// GET /api/users/:id - pobierz profil użytkownika
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id)
      .select("name email role level providerLevel location locationCoords price time services provider_status promo badges kyc rankingPoints verified service bio headline priceNote company createdAt avatar")
      .populate('company', 'name logo')
      .populate('services', 'name_pl name_en parent_slug slug code icon')
      .lean();
    
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }
    
    // Pobierz subscription plan
    const UserSubscription = require('../models/UserSubscription');
    const subscription = await UserSubscription.findOne({
      user: user._id,
      status: 'active'
    }).lean();
    const planKey = subscription?.planKey || null;

    // Pobierz boosty (tylko dla providerów)
    let boosts = [];
    if (user.role === 'provider') {
      const Boost = require('../models/Boost');
      boosts = await Boost.find({
        provider: user._id,
        $or: [
          { endsAt: { $gt: new Date() } },
          { endsAt: null }
        ]
      }).select('code endsAt').lean();
    }
    
    // Pobierz ostatnie recenzje (tylko dla providerów)
    let lastReviews = [];
    if (user.role === 'provider') {
      const Rating = require('../models/Rating');
      const reviews = await Rating.find({ to: user._id, status: 'active' })
        .populate('from', 'name avatar')
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();
      
      lastReviews = reviews.map(r => ({
        _id: r._id,
        stars: r.rating,
        comment: r.comment,
        authorName: r.from?.name || 'Klient',
        authorAvatar: r.from?.avatar,
        createdAt: r.createdAt
      }));
    }
    
    // Sprawdź rolę w firmie i typ firmy (tylko dla providerów z firmą)
    let companyInfo = null;
    if (user.company && user.role === 'provider') {
      const Company = require('../models/Company');
      const company = await Company.findById(user.company._id).lean();
      if (company) {
        const isOwner = String(company.owner) === String(user._id);
        const isManager = company.managers?.some(m => String(m) === String(user._id)) || false;
        const teamSize = (company.providers?.length || 0) + (company.managers?.length || 0) + 1; // +1 for owner
        const isSinglePerson = teamSize === 1;
        
        companyInfo = {
          _id: company._id,
          name: company.name,
          logo: company.logo,
          isOwner,
          isManager,
          teamSize,
          isSinglePerson,
          verified: company.verified || false,
          status: company.status || 'pending'
        };
      }
    }
    
    const userObj = {
      ...user,
      company: companyInfo || (user.company ? {
        _id: user.company._id,
        name: user.company.name,
        logo: user.company.logo
      } : null),
      subscriptionPlan: planKey,
      planKey: planKey,
      boosts: boosts.map(b => ({
        code: b.code,
        endsAt: b.endsAt
      })),
      lastReviews: lastReviews
    };
    
    res.json(userObj);
  } catch (err) {
    console.error('GET_USER_PROFILE_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

module.exports = router;




