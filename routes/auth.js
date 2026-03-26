const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const logger = require('../utils/logger');
// Lazy-load to avoid serverless cold-start crashes when not needed (e.g., on /login)
let EmailVerificationService = null;
function getEmailService() {
  if (!EmailVerificationService) {
    try {
      EmailVerificationService = require('../services/emailVerificationService');
    } catch (e) {
      logger.error('EMAIL_SERVICE_LOAD_ERROR:', e.message);
    }
  }
  return EmailVerificationService;
}
const { validateRegistration, validateLogin } = require('../middleware/inputValidator');
const { validate } = require('../middleware/validation');
const router = express.Router();

// Endpoint diagnostyczny – tylko poza produkcją
if (process.env.NODE_ENV !== 'production') {
  router.get('/test', (req, res) => {
    res.json({
      message: 'Auth route works!',
      dbConnected: mongoose.connection.readyState === 1,
      timestamp: new Date().toISOString()
    });
  });
}

// Safe login handler (bypasses custom validators that may crash in serverless)
// This route is registered BEFORE the advanced login below and will handle requests first.
router.post('/login', async (req, res) => {
  try {
    logger.debug('LOGIN_ATTEMPT: Request received', { 
      hasBody: !!req.body, 
      bodyKeys: req.body ? Object.keys(req.body) : [],
      dbState: mongoose.connection.readyState 
    });
    
    // Upewnij się, że req.body jest zdefiniowane
    if (!req.body) {
      logger.warn('LOGIN_SAFE_ERROR: No request body');
      return res.status(400).json({ message: 'Brak danych w żądaniu' });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      logger.warn('LOGIN_SAFE_ERROR: Missing email or password', { hasEmail: !!email, hasPassword: !!password });
      return res.status(400).json({ message: 'Podaj email i hasło' });
    }

    // Sprawdź połączenie z bazą danych
    if (mongoose.connection.readyState !== 1) {
      logger.error('LOGIN_SAFE_ERROR: Database not connected', { readyState: mongoose.connection.readyState });
      return res.status(500).json({ message: 'Błąd połączenia z bazą danych' });
    }

    logger.debug('LOGIN_ATTEMPT: Looking up user', { email });
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Nieprawidłowe dane logowania' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: 'Nieprawidłowe dane logowania' });
    }

    // Jeśli wymagana jest zmiana hasła (pierwsze logowanie), pozwól na logowanie bez weryfikacji email
    // (email jest już zweryfikowany przez firmę przy tworzeniu konta)
    if (!user.emailVerified && !user.requiresPasswordChange) {
      return res.status(403).json({ 
        message: 'Musisz potwierdzić swój email przed zalogowaniem. Sprawdź swoją skrzynkę email.',
        emailNotVerified: true
      });
    }

    // Sprawdź czy 2FA jest włączone
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const { twoFactorToken } = req.body;
      
      if (!twoFactorToken) {
        return res.status(200).json({
          requires2FA: true,
          message: 'Wymagany kod weryfikacyjny z aplikacji autentykatora'
        });
      }

      // Weryfikuj kod 2FA
      let speakeasy;
      try {
        speakeasy = require('speakeasy');
      } catch (e) {
        logger.error('speakeasy not installed');
        return res.status(500).json({ message: 'Błąd konfiguracji 2FA' });
      }

      const verified = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: 'base32',
        token: twoFactorToken,
        window: 2 // Pozwól na 2 okna czasowe wstecz/przód (60 sekund)
      });

      // Jeśli kod TOTP nie działa, sprawdź kody zapasowe
      if (!verified && user.twoFactorBackupCodes && user.twoFactorBackupCodes.length > 0) {
        const crypto = require('crypto');
        const hashedToken = crypto.createHash('sha256').update(twoFactorToken).digest('hex');
        const backupMatch = user.twoFactorBackupCodes.some(code => code === hashedToken);
        
        if (backupMatch) {
          // Usuń użyty kod zapasowy
          await User.findByIdAndUpdate(user._id, {
            $pull: { twoFactorBackupCodes: hashedToken }
          });
        } else {
          return res.status(400).json({ message: 'Nieprawidłowy kod weryfikacyjny' });
        }
      } else if (!verified) {
        return res.status(400).json({ message: 'Nieprawidłowy kod weryfikacyjny' });
      }
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: 'Błąd konfiguracji serwera' });
    }

    // Gamification: aktualizuj login streak i przyznaj punkty za daily login
    const userForStreak = await User.findById(user._id);
    const updateData = {
      'provider_status.isOnline': true,
      'provider_status.lastSeenAt': new Date()
    };
    
    if (userForStreak) {
      const lastLogin = userForStreak.gamification?.lastLoginDate;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      if (lastLogin) {
        const lastLoginDate = new Date(lastLogin);
        lastLoginDate.setHours(0, 0, 0, 0);
        const daysDiff = Math.floor((today - lastLoginDate) / (1000 * 60 * 60 * 24));
        
        if (daysDiff === 1) {
          // Kolejny dzień z rzędu
          updateData['gamification.loginStreak'] = (userForStreak.gamification?.loginStreak || 0) + 1;
          updateData['gamification.lastLoginDate'] = new Date();
          
          // Przyznaj 5 punktów za daily login
          try {
            const PointTransaction = require('../models/PointTransaction');
            if (PointTransaction) {
              const lastTx = await PointTransaction.findOne({ user: user._id }).sort({ createdAt: -1 });
              const currentBalance = lastTx?.balanceAfter || 0;
              
              await PointTransaction.create({
                user: user._id,
                delta: 5,
                reason: 'daily_login',
                balanceAfter: currentBalance + 5
              });
            }
          } catch (pointsError) {
            logger.error('Error awarding daily login points:', pointsError);
            // Nie przerywaj logowania jeśli punkty się nie udały
          }
          
          // Gamification: sprawdź streak badges
          try {
            const gamification = require('../utils/gamification');
            if (gamification && gamification.checkStreakBadges) {
              await gamification.checkStreakBadges(user._id, updateData['gamification.loginStreak']);
            }
          } catch (streakError) {
            logger.error('Error checking streak badges:', streakError);
            // Nie przerywaj logowania jeśli badges się nie udały
          }
        } else if (daysDiff > 1) {
          // Przerwa w streak - reset
          updateData['gamification.loginStreak'] = 1;
          updateData['gamification.lastLoginDate'] = new Date();
        } else {
          // daysDiff === 0 oznacza że już logował się dziś - nie zwiększaj streak
          updateData['gamification.lastLoginDate'] = new Date();
        }
      } else {
        // Pierwsze logowanie
        updateData['gamification.loginStreak'] = 1;
        updateData['gamification.lastLoginDate'] = new Date();
        
        // Gamification: przyznaj badge za pierwsze logowanie
        try {
          const gamification = require('../utils/gamification');
          if (gamification && gamification.awardBadge && gamification.BADGES) {
            await gamification.awardBadge(user._id, gamification.BADGES.FIRST_LOGIN);
          }
        } catch (firstLoginError) {
          logger.error('Error awarding first login badge:', firstLoginError);
          // Nie przerywaj logowania jeśli badge się nie udał
        }
      }
    }
    
    // Aktualizuj lastActivity dla email marketing
    updateData['emailMarketing.lastActivity'] = new Date();
    
    await User.findByIdAndUpdate(user._id, updateData);

    // Sprawdź czy wymagana jest zmiana hasła
    const fresh = await User.findById(user._id).select('name email phone role isB2B onboardingCompleted requiresPasswordChange company roleInCompany');
    
    if (!fresh) {
      logger.error('LOGIN_SAFE_ERROR: User not found after update', { userId: user._id });
      return res.status(500).json({ message: 'Błąd serwera - użytkownik nie został znaleziony' });
    }
    
    if (fresh.requiresPasswordChange) {
      // Zwróć specjalny token do zmiany hasła (krótszy czas ważności)
      const passwordChangeToken = jwt.sign({ 
        id: user._id, 
        requiresPasswordChange: true 
      }, process.env.JWT_SECRET, { expiresIn: '1h' });
      
      return res.json({
        requiresPasswordChange: true,
        token: passwordChangeToken,
        message: 'Musisz zmienić hasło przed pierwszym logowaniem',
        user: {
          id: fresh._id,
          name: fresh.name,
          email: fresh.email,
          phone: fresh.phone,
          role: fresh.role,
          isB2B: fresh.isB2B,
          company: fresh.company,
          roleInCompany: fresh.roleInCompany
        }
      });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: {
        id: fresh._id,
        name: fresh.name,
        email: fresh.email,
        phone: fresh.phone,
        role: fresh.role,
        isB2B: fresh.isB2B,
        company: fresh.company,
        roleInCompany: fresh.roleInCompany,
        onboardingCompleted: fresh.onboardingCompleted
      }
    });
  } catch (err) {
    logger.error('LOGIN_SAFE_ERROR:', {
      message: err.message,
      stack: err.stack,
      email: req.body?.email,
      name: err.name,
      code: err.code
    });
    // Upewnij się, że odpowiedź nie została już wysłana
    if (!res.headersSent) {
      return res.status(500).json({ 
        message: 'Błąd serwera',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    } else {
      logger.error('LOGIN_SAFE_ERROR: Response already sent, cannot send error response');
    }
  }
});

// Rejestracja
router.post('/register', validate('register'), validateRegistration, async (req, res) => {
  let { name, email, password, role, isB2B, phone, address, locationCoords, company, notificationPreferences } = req.body;
  
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Użytkownik już istnieje' });

    // Bezpieczeństwo: tylko dozwolone role z whitelisty
    const ALLOWED_ROLES = ["client", "provider"];
    if (!ALLOWED_ROLES.includes(role)) {
      role = "client"; // domyślna rola
    }

    // NIGDY nie pozwalaj publicznie na admina
    if (role === "admin") {
      role = "client";
    }

    // Jeśli podano dane firmy, waliduj i sprawdź czy firma z tym NIP już istnieje
    if (company && company.nip) {
      const { validateCompanyData } = require('../utils/companyValidation');
      const Company = require('../models/Company');
      
      // Walidacja danych firmy
      const validation = validateCompanyData(company);
      if (!validation.valid) {
        return res.status(400).json({ 
          message: 'Błędy walidacji danych firmy',
          errors: validation.errors
        });
      }
      
      const existingCompany = await Company.findOne({ nip: company.nip });
      if (existingCompany) {
        return res.status(400).json({ message: 'Firma z tym NIP już istnieje' });
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    
    // Przygotuj dane użytkownika
    const userData = {
      name,
      email,
      phone,
      password: hashed,
      role,
      isB2B: !!isB2B || !!company,
      onboardingCompleted: role === "provider" ? false : true,
      emailVerified: false, // Email nie jest zweryfikowany
      // Zgody marketingowe
      notificationPreferences: notificationPreferences ? {
        marketing: {
          sms: !!notificationPreferences.marketing?.sms,
          email: !!notificationPreferences.marketing?.email
        }
      } : undefined,
    };
    
    // Domyślne wartości dla providerów
    if (role === "provider") {
      userData.verified = false; // Niezweryfikowany na start
      userData.b2b = !!isB2B || !!company; // Ustaw B2B na podstawie isB2B lub company
      userData.level = "standard"; // Domyślny poziom
      
      // Dla providerów B2B (isB2B = true, bez przypisania do firmy) 
      // automatycznie włącz samofakturowanie
      if (userData.isB2B && !company) {
        userData.selfBillingEnabled = true;
        userData.selfBillingAgreementAcceptedAt = new Date();
      }
    }
    
    // Dane do faktury dla providera z "wystawiam faktury" (isB2B)
    if (role === 'provider' && (req.body.billing || isB2B)) {
      const b = req.body.billing || {};
      userData.billing = {
        customerType: 'company',
        companyName: (b.companyName || '').trim(),
        nip: (b.nip || '').replace(/\s/g, ''),
        street: (b.street || '').trim(),
        city: (b.city || '').trim(),
        postalCode: (b.postalCode || '').trim(),
        country: (b.country || 'Polska').trim(),
      };
    }

    // Dodaj dane lokalizacji dla wykonawców (wymagane) i klientów (opcjonalne)
    if (address) {
      userData.address = address;
      // Wyciągnij miasto z adresu dla pola location
      const cityMatch = address.match(/([^,]+)$/);
      if (cityMatch) {
        userData.location = cityMatch[1].trim();
      }
    }
    if (locationCoords && locationCoords.lat && locationCoords.lng) {
      userData.locationCoords = {
        lat: parseFloat(locationCoords.lat),
        lng: parseFloat(locationCoords.lng)
      };
    }
    
    // Generuj kod referencyjny dla nowego użytkownika
    const crypto = require('crypto');
    const referralCode = `HELPFLI-${crypto.createHash('sha256').update(String(userData.email) + Date.now()).digest('hex').substring(0, 8).toUpperCase()}`;
    userData.referralCode = referralCode;
    
    const user = await User.create(userData);

    // Jeśli podano dane firmy, utwórz firmę i przypisz użytkownika jako właściciela
    if (company && company.name && company.nip) {
      const Company = require('../models/Company');
      const { initializeCompanyResourcePool } = require('../utils/resourcePool');
      
      // Utwórz firmę
      const newCompany = new Company({
        name: company.name,
        nip: company.nip,
        regon: company.regon || undefined,
        email: email,
        phone: phone,
        address: company.address || address || undefined,
        owner: user._id,
        status: 'pending' // Wymaga weryfikacji
      });

      await newCompany.save();

      // Zaktualizuj użytkownika - przypisz do firmy jako właściciel
      user.company = newCompany._id;
      user.roleInCompany = 'owner';
      // Zmień rolę na company_owner jeśli to provider, w przeciwnym razie zostaw client
      if (role === "provider") {
        user.role = 'company_owner';
      }
      await user.save();

      // Zainicjalizuj resource pool dla firmy
      try {
        await initializeCompanyResourcePool(newCompany._id);
      } catch (poolError) {
        logger.error('Error initializing company resource pool:', poolError);
        // Nie blokuj rejestracji jeśli pool się nie zainicjalizował
      }

      logger.info(`Company ${newCompany.name} created during registration for user ${user._id}`);
    }
    
    // Obsługa kodu referencyjnego jeśli został podany
    if (req.body.referralCode) {
      try {
        const Referral = require('../models/Referral');
        const PointTransaction = require('../models/PointTransaction');
        
        // Znajdź referrera po kodzie
        const existingReferral = await Referral.findOne({ referralCode: req.body.referralCode });
        let referrerId = null;
        
        if (existingReferral) {
          referrerId = existingReferral.referrer;
        } else {
          // Sprawdź czy użytkownik ma taki kod
          const referrer = await User.findOne({ referralCode: req.body.referralCode });
          if (referrer) {
            referrerId = referrer._id;
          }
        }
        
        if (referrerId && String(referrerId) !== String(user._id)) {
          // Sprawdź czy użytkownik nie został już zaproszony
          const alreadyReferred = await Referral.findOne({ referred: user._id });
          if (!alreadyReferred) {
            // Różne nagrody w zależności od roli zaproszonego użytkownika
            const referredRole = user.role || 'client';
            const referrerPoints = referredRole === 'provider' ? 100 : 50; // Więcej punktów za polecenie providera
            const referredPoints = 50; // Zawsze 50 punktów dla zaproszonego
            
            // Utwórz rekord referencji
            const referral = await Referral.create({
              referrer: referrerId,
              referred: user._id,
              referredRole: referredRole,
              referralCode: req.body.referralCode,
              status: 'completed',
              completedAt: new Date(),
              referrerReward: { points: referrerPoints, givenAt: new Date() },
              referredReward: { points: referredPoints, givenAt: new Date() }
            });
            
            // Przyznaj punkty referrerowi
            const referrerBalance = (await PointTransaction.findOne({ user: referrerId }).sort({ createdAt: -1 }))?.balanceAfter || 0;
            await PointTransaction.create({
              user: referrerId,
              delta: referrerPoints,
              reason: `referral_signup_${referredRole}`,
              balanceAfter: referrerBalance + referrerPoints
            });
            
            // Przyznaj punkty zaproszonemu
            const referredBalance = 0;
            await PointTransaction.create({
              user: user._id,
              delta: referredPoints,
              reason: 'referral_signup',
              balanceAfter: referredBalance + referredPoints
            });
            
            logger.info(`Referral code applied for ${referredRole}:`, user._id, `Referrer gets ${referrerPoints} points`);
          }
        }
      } catch (error) {
        logger.error('Error applying referral code:', error);
        // Nie blokuj rejestracji
      }
    }

    let verificationEmailSent = true;

    // W trybie deweloperskim automatycznie weryfikuj email.
    // UWAGA: brak SMTP_HOST nie oznacza "dev" – w produkcji możemy używać Resend (RESEND_API_KEY).
    const mailConfigured =
      !!process.env.RESEND_API_KEY ||
      (!!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS);

    if (process.env.NODE_ENV === 'development') {
      logger.debug('DEV_MODE: Auto-verifying email for development');
      user.emailVerified = true;
      await user.save();
    } else {
      // Produkcja: wysyłaj email weryfikacyjny jeśli mamy skonfigurowany provider maili.
      if (!mailConfigured) {
        verificationEmailSent = false;
      } else {
        try {
          const svc = getEmailService();
          await svc?.sendVerificationEmail(user);
        } catch (emailError) {
          logger.error('EMAIL_SEND_ERROR:', emailError);
          // Nie usuwaj konta przy błędzie maila - użytkownik może ponowić wysyłkę.
          verificationEmailSent = false;
        }
      }
    }
    
    // Email Marketing: Wyślij welcome email 1 (natychmiast)
    try {
      const { sendWelcomeEmail1 } = require('../jobs/emailMarketing');
      // Opóźnij o 5 sekund, żeby nie blokować odpowiedzi
      setTimeout(async () => {
        await sendWelcomeEmail1(user);
      }, 5000);
    } catch (emailError) {
      logger.error('Error scheduling welcome email 1:', emailError);
      // Nie blokuj rejestracji jeśli email się nie udał
    }

    // Pobierz świeże dane użytkownika (po ewentualnej zmianie roli na company_owner)
    const freshUser = await User.findById(user._id).select('name email phone role isB2B onboardingCompleted company roleInCompany');
    
    // W trybie deweloperskim zwróć token, w produkcji komunikat o weryfikacji
    if (process.env.NODE_ENV === 'development') {
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      res.json({ 
        success: true,
        message: 'Konto zostało utworzone i automatycznie zweryfikowane (tryb deweloperski)!',
        token,
        user: { 
          id: freshUser._id, 
          name: freshUser.name, 
          email: freshUser.email, 
          phone: freshUser.phone,
          role: freshUser.role, // Użyj zaktualizowanej roli (może być company_owner)
          isB2B: freshUser.isB2B,
          onboardingCompleted: freshUser.onboardingCompleted,
          company: freshUser.company,
          roleInCompany: freshUser.roleInCompany,
          emailVerified: true
        } 
      });
    } else {
      res.json({ 
        success: true,
        message: verificationEmailSent
          ? 'Konto zostało utworzone! Sprawdź swój email i kliknij w link weryfikacyjny.'
          : 'Konto zostało utworzone, ale nie udało się wysłać emaila weryfikacyjnego. Użyj opcji ponownej wysyłki.',
        verificationEmailSent,
        user: { 
          id: freshUser._id, 
          name: freshUser.name, 
          email: freshUser.email, 
          phone: freshUser.phone,
          role: freshUser.role, // Użyj zaktualizowanej roli (może być company_owner)
          isB2B: freshUser.isB2B,
          onboardingCompleted: freshUser.onboardingCompleted,
          company: freshUser.company,
          roleInCompany: freshUser.roleInCompany,
          emailVerified: false
        } 
      });
    }
  } catch (err) {
    logger.error('REGISTER_ERROR:', {
      message: err.message,
      stack: err.stack,
      email: req.body?.email
    });
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Drugi endpoint /login został usunięty - używamy pierwszego "safe login handler" powyżej,
// który obsługuje więcej funkcji (2FA, gamification, itp.)

const { authMiddleware } = require('../middleware/authMiddleware');

// Sprawdzenie danych zalogowanego użytkownika
router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Pobierz informacje o subskrypcji użytkownika
    const UserSubscription = require('../models/UserSubscription');
    const SubscriptionPlan = require('../models/SubscriptionPlan');
    
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() } // Tylko aktywne subskrypcje
    });
    
    let subscriptionInfo = null;
    if (subscription) {
      const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
      subscriptionInfo = {
        planKey: subscription.planKey,
        planName: plan?.name || subscription.planKey,
        validUntil: subscription.validUntil,
        renews: subscription.renews
      };
    }
    
    // Zwróć dane użytkownika z informacją o subskrypcji
    res.json({
      ...req.user.toObject(),
      subscription: subscriptionInfo
    });
  } catch (error) {
    logger.error('Error in /me endpoint:', error);
    res.json(req.user);
  }
});

// DEV ONLY: elevate current user to admin for testing
router.post('/dev/elevate-admin', authMiddleware, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: 'Not allowed in production' });
    }
    await User.findByIdAndUpdate(req.user._id, { role: 'admin' });
    const fresh = await User.findById(req.user._id).select('name email role');
    res.json({ ok: true, user: fresh });
  } catch (e) {
    res.status(500).json({ message: 'Elevate failed' });
  }
});

// Wylogowanie - ustaw status offline
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    // Ustaw status offline przy wylogowaniu
    await User.findByIdAndUpdate(req.user.id, {
      'provider_status.isOnline': false,
      'provider_status.lastSeenAt': new Date()
    });
    
    res.json({ message: 'Wylogowano pomyślnie' });
  } catch (err) {
    logger.error('LOGOUT_ERROR:', {
      message: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Pobierz wszystkich dostawców usług (providers)
router.get('/providers', async (req, res) => {
  try {
    const providers = await User.find({ role: 'provider' });
    res.json(providers);
  } catch (err) {
    res.status(500).json({ message: 'Błąd pobierania dostawców' });
  }
});

// Pobierz pojedynczego użytkownika po ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Błąd pobierania użytkownika' });
  }
});

// Pobierz pojedynczego providera po ID
router.get('/providers/:id', async (req, res) => {
  try {
    const provider = await User.findById(req.params.id)
      .select('-password')
      .where('role', 'provider');
    
    if (!provider) {
      return res.status(404).json({ message: 'Provider nie został znaleziony' });
    }
    res.json(provider);
  } catch (err) {
    res.status(500).json({ message: 'Błąd pobierania providera' });
  }
});

// Weryfikacja emaila
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ message: 'Token weryfikacyjny jest wymagany' });
  }

  try {
    const svc = getEmailService();
    const result = await (svc?.verifyToken(token));
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Email został pomyślnie zweryfikowany! Możesz się teraz zalogować.',
        user: result.user
      });
    } else {
      res.status(400).json({ message: result.message });
    }
  } catch (err) {
    logger.error('VERIFY_EMAIL_ERROR:', {
      message: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Błąd weryfikacji emaila' });
  }
});

// Ponowne wysłanie emaila weryfikacyjnego
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ message: 'Email jest wymagany' });
  }

  try {
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ message: 'Email jest już zweryfikowany' });
    }

    // Wysyłaj ponownie email weryfikacyjny
    const svc = getEmailService();
    await svc?.sendVerificationEmail(user);
    
    res.json({ 
      success: true, 
      message: 'Email weryfikacyjny został ponownie wysłany. Sprawdź swoją skrzynkę email.' 
    });
  } catch (err) {
    logger.error('RESEND_VERIFICATION_ERROR:', {
      message: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Błąd wysyłania emaila weryfikacyjnego' });
  }
});

module.exports = router;