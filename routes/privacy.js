const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const PrivacyService = require('../services/PrivacyService');
const { validateObjectId } = require('../middleware/inputValidator');
const User = require('../models/User');

// GET /api/privacy/data-export - eksport danych użytkownika
router.get('/data-export', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Log operacji
    await PrivacyService.logPrivacyOperation(userId, 'export', {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    const exportData = await PrivacyService.exportUserData(userId);
    
    res.json({
      success: true,
      data: exportData,
      message: 'Dane zostały wyeksportowane'
    });
  } catch (error) {
    console.error('Data export error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd eksportu danych' 
    });
  }
});

// GET /api/privacy/can-delete - sprawdź czy można usunąć dane
router.get('/can-delete', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const result = await PrivacyService.canDeleteData(userId);
    
    res.json(result);
  } catch (error) {
    console.error('Can delete check error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd sprawdzania możliwości usunięcia danych' 
    });
  }
});

// POST /api/privacy/anonymize - anonimizacja danych
router.post('/anonymize', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Sprawdź czy można usunąć dane
    const canDelete = await PrivacyService.canDeleteData(userId);
    if (!canDelete.canDelete) {
      return res.status(400).json({
        success: false,
        message: `Nie można usunąć danych: ${canDelete.reason}`,
        details: canDelete
      });
    }

    // Potwierdzenie przez użytkownika
    const { confirm } = req.body;
    if (confirm !== 'ANONIMIZUJ_MOJE_DANE') {
      return res.status(400).json({
        success: false,
        message: 'Wymagane potwierdzenie operacji'
      });
    }

    // Log operacji
    await PrivacyService.logPrivacyOperation(userId, 'anonymize', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      confirmed: true
    });

    const result = await PrivacyService.anonymizeUserData(userId);
    
    res.json(result);
  } catch (error) {
    console.error('Anonymization error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd anonimizacji danych' 
    });
  }
});

// POST /api/privacy/delete - pełne usunięcie danych (admin only)
router.post('/delete/:userId', authMiddleware, validateObjectId('userId'), async (req, res) => {
  try {
    // Tylko admin może usunąć dane kompletnie
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Brak uprawnień do tej operacji'
      });
    }

    const userId = req.params.userId;
    
    // Log operacji
    await PrivacyService.logPrivacyOperation(userId, 'delete', {
      performedBy: req.user._id,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    const result = await PrivacyService.deleteUserDataCompletely(userId);
    
    res.json(result);
  } catch (error) {
    console.error('Complete deletion error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd usuwania danych' 
    });
  }
});

// GET /api/privacy/policy - polityka prywatności
router.get('/policy', (req, res) => {
  const policy = {
    lastUpdated: new Date().toISOString(),
    version: '1.0',
    sections: {
      introduction: {
        title: 'Wprowadzenie',
        content: 'Niniejsza Polityka Prywatności opisuje, jak Helpfli sp. z o.o. („Helpfli", „my", „nas") zbiera, wykorzystuje i chroni Twoje dane osobowe zgodnie z Rozporządzeniem o Ochronie Danych Osobowych (RODO).'
      },
      dataController: {
        title: 'Administrator Danych',
        content: 'Administratorem Twoich danych osobowych jest Helpfli sp. z o.o. z siedzibą w Warszawie, adres: [ADRES], NIP: [NIP], REGON: [REGON].'
      },
      dataCollection: {
        title: 'Jakie dane zbieramy',
        content: 'Zbieramy następujące kategorie danych: dane identyfikacyjne (imię, nazwisko, email), dane kontaktowe (telefon, adres), dane lokalizacyjne, dane transakcyjne, dane techniczne (IP, cookies), dane weryfikacyjne (KYC).'
      },
      dataUsage: {
        title: 'Jak wykorzystujemy dane',
        content: 'Dane wykorzystujemy do: świadczenia usług platformy, weryfikacji użytkowników, przetwarzania płatności, komunikacji, analityki i marketingu (za zgodą), zapewnienia bezpieczeństwa.'
      },
      legalBasis: {
        title: 'Podstawa prawna',
        content: 'Przetwarzamy dane na podstawie: wykonania umowy (art. 6 ust. 1 lit. b RODO), prawnie uzasadnionego interesu (art. 6 ust. 1 lit. f RODO), zgody (art. 6 ust. 1 lit. a RODO), obowiązku prawnego (art. 6 ust. 1 lit. c RODO).'
      },
      dataRetention: {
        title: 'Okres przechowywania',
        content: 'Dane przechowujemy przez okres: aktywności konta + 3 lata (dane konta), 5 lat (dane księgowe), 10 lat (dane KYC), do wycofania zgody (marketing).'
      },
      userRights: {
        title: 'Twoje prawa',
        content: 'Masz prawo do: dostępu do danych, sprostowania, usunięcia, ograniczenia przetwarzania, przenoszenia danych, sprzeciwu, wycofania zgody. Skontaktuj się z nami: privacy@helpfli.pl'
      },
      dataSecurity: {
        title: 'Bezpieczeństwo danych',
        content: 'Stosujemy środki techniczne i organizacyjne: szyfrowanie, kontrolę dostępu, regularne audyty, szkolenia personelu, backup danych.'
      },
      cookies: {
        title: 'Pliki cookies',
        content: 'Używamy cookies do: funkcjonalności strony, analityki, marketingu. Możesz zarządzać cookies w ustawieniach przeglądarki.'
      },
      contact: {
        title: 'Kontakt',
        content: 'W sprawach ochrony danych kontaktuj się z nami: email: privacy@helpfli.pl, adres: [ADRES], telefon: [TELEFON].'
      }
    }
  };

  res.json(policy);
});

// GET /api/privacy/consent-status - status zgód użytkownika
router.get('/consent-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('consents marketingConsent').lean();
    
    const consentStatus = {
      marketing: user?.marketingConsent || false,
      analytics: user?.consents?.analytics || false,
      cookies: user?.consents?.cookies || false,
      updatedAt: user?.consents?.updatedAt || null
    };

    res.json(consentStatus);
  } catch (error) {
    console.error('Consent status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd pobierania statusu zgód' 
    });
  }
});

// POST /api/privacy/consent - zarządzanie zgodami
router.post('/consent', authMiddleware, async (req, res) => {
  try {
    const { marketing, analytics, cookies } = req.body;
    const userId = req.user._id;

    const updateData = {
      marketingConsent: marketing || false,
      consents: {
        analytics: analytics || false,
        cookies: cookies || false,
        updatedAt: new Date()
      }
    };

    await User.findByIdAndUpdate(userId, updateData);

    // Log operacji
    await PrivacyService.logPrivacyOperation(userId, 'consent_update', {
      consents: updateData.consents,
      marketing: updateData.marketingConsent,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: 'Zgody zostały zaktualizowane',
      consents: updateData
    });
  } catch (error) {
    console.error('Consent update error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd aktualizacji zgód' 
    });
  }
});

module.exports = router;
