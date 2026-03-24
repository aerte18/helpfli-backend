// Zarządzanie white-label
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const WhiteLabel = require('../models/WhiteLabel');
const whiteLabelService = require('../services/whiteLabelService');

// POST /api/whitelabel - Utwórz nowy white-label
router.post('/', authMiddleware, requireRole(['admin', 'company_owner']), async (req, res) => {
  try {
    const { name, slug, branding, domains, ui, companyId } = req.body;
    const userId = req.user._id;

    // Sprawdź czy slug jest dostępny
    const existing = await WhiteLabel.findOne({ slug });
    if (existing) {
      return res.status(400).json({ message: 'Slug już istnieje' });
    }

    const whiteLabel = await whiteLabelService.createWhiteLabel(userId, companyId, {
      name,
      slug,
      branding,
      domains,
      ui
    });

    res.status(201).json({
      whiteLabel: {
        _id: whiteLabel._id,
        name: whiteLabel.name,
        slug: whiteLabel.slug,
        status: whiteLabel.status,
        isActive: whiteLabel.isActive
      },
      message: 'White-label utworzony. Wymaga aktywacji przez administratora.'
    });
  } catch (error) {
    console.error('CREATE_WHITELABEL_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd tworzenia white-label' });
  }
});

// GET /api/whitelabel - Lista white-labelów użytkownika
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const { companyId } = req.query;

    const query = { owner: userId };
    if (companyId) query.company = companyId;

    const whiteLabels = await WhiteLabel.find(query)
      .select('-ui.customCss -ui.customJs') // Nie zwracamy custom CSS/JS
      .sort({ createdAt: -1 });

    res.json({ whiteLabels });
  } catch (error) {
    console.error('GET_WHITELABELS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania white-labelów' });
  }
});

// GET /api/whitelabel/:whitelabelId - Szczegóły white-label
router.get('/:whitelabelId', authMiddleware, async (req, res) => {
  try {
    const { whitelabelId } = req.params;
    const userId = req.user._id;

    const whiteLabel = await WhiteLabel.findOne({ 
      _id: whitelabelId, 
      owner: userId 
    });

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    res.json({ whiteLabel });
  } catch (error) {
    console.error('GET_WHITELABEL_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania white-label' });
  }
});

// GET /api/whitelabel/slug/:slug - Pobierz white-label po slug (publiczne)
router.get('/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const whiteLabel = await whiteLabelService.getBySlug(slug);

    if (!whiteLabel || !whiteLabel.isActive) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    // Zwróć tylko publiczne dane
    res.json({
      whiteLabel: {
        _id: whiteLabel._id,
        name: whiteLabel.name,
        slug: whiteLabel.slug,
        branding: whiteLabel.branding,
        domains: whiteLabel.domains.filter(d => d.verified),
        ui: {
          layout: whiteLabel.ui.layout,
          components: whiteLabel.ui.components,
          pages: whiteLabel.ui.pages
        }
      }
    });
  } catch (error) {
    console.error('GET_WHITELABEL_BY_SLUG_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania white-label' });
  }
});

// GET /api/whitelabel/domain/:domain - Pobierz white-label po domenie (publiczne)
router.get('/domain/:domain', async (req, res) => {
  try {
    const { domain } = req.params;

    const whiteLabel = await whiteLabelService.getByDomain(domain);

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony dla tej domeny' });
    }

    // Zwiększ statystyki wizyt
    await whiteLabelService.incrementVisit(whiteLabel._id, false);

    res.json({
      whiteLabel: {
        _id: whiteLabel._id,
        name: whiteLabel.name,
        slug: whiteLabel.slug,
        branding: whiteLabel.branding,
        ui: {
          layout: whiteLabel.ui.layout,
          components: whiteLabel.ui.components,
          pages: whiteLabel.ui.pages
        }
      }
    });
  } catch (error) {
    console.error('GET_WHITELABEL_BY_DOMAIN_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania white-label' });
  }
});

// PATCH /api/whitelabel/:whitelabelId - Aktualizuj white-label
router.patch('/:whitelabelId', authMiddleware, async (req, res) => {
  try {
    const { whitelabelId } = req.params;
    const userId = req.user._id;
    const { branding, domains, ui, name } = req.body;

    const whiteLabel = await WhiteLabel.findOne({ 
      _id: whitelabelId, 
      owner: userId 
    });

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    if (name) whiteLabel.name = name;
    if (branding) whiteLabel.branding = { ...whiteLabel.branding, ...branding };
    if (domains) {
      // Aktualizuj domeny
      domains.forEach(newDomain => {
        const existing = whiteLabel.domains.find(d => d.domain === newDomain.domain);
        if (existing) {
          Object.assign(existing, newDomain);
        } else {
          whiteLabel.domains.push(newDomain);
        }
      });
    }
    if (ui) whiteLabel.ui = { ...whiteLabel.ui, ...ui };

    await whiteLabel.save();

    res.json({
      whiteLabel: {
        _id: whiteLabel._id,
        name: whiteLabel.name,
        slug: whiteLabel.slug,
        branding: whiteLabel.branding,
        status: whiteLabel.status
      }
    });
  } catch (error) {
    console.error('UPDATE_WHITELABEL_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktualizacji white-label' });
  }
});

// POST /api/whitelabel/:whitelabelId/domains - Dodaj domenę
router.post('/:whitelabelId/domains', authMiddleware, async (req, res) => {
  try {
    const { whitelabelId } = req.params;
    const { domain, isPrimary } = req.body;
    const userId = req.user._id;

    const whiteLabel = await WhiteLabel.findOne({ 
      _id: whitelabelId, 
      owner: userId 
    });

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    await whiteLabel.addDomain(domain, isPrimary || false);

    // Generuj token weryfikacyjny
    const verification = whiteLabelService.generateDomainVerificationToken(domain);

    res.json({
      message: 'Domena dodana',
      domain: {
        domain,
        isPrimary,
        verified: false
      },
      verification: {
        token: verification.token,
        txtRecord: verification.record,
        instructions: `Dodaj następujący TXT record do DNS domeny: ${verification.record}`
      }
    });
  } catch (error) {
    console.error('ADD_DOMAIN_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd dodawania domeny' });
  }
});

// POST /api/whitelabel/:whitelabelId/domains/:domain/verify - Weryfikuj domenę
router.post('/:whitelabelId/domains/:domain/verify', authMiddleware, async (req, res) => {
  try {
    const { whitelabelId, domain } = req.params;
    const userId = req.user._id;

    const whiteLabel = await WhiteLabel.findOne({ 
      _id: whitelabelId, 
      owner: userId 
    });

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    const result = await whiteLabelService.verifyDomain(whitelabelId, domain);

    res.json(result);
  } catch (error) {
    console.error('VERIFY_DOMAIN_ERROR:', error);
    res.status(500).json({ message: error.message || 'Błąd weryfikacji domeny' });
  }
});

// GET /api/whitelabel/:whitelabelId/css - Pobierz custom CSS
router.get('/:whitelabelId/css', async (req, res) => {
  try {
    const { whitelabelId } = req.params;

    const whiteLabel = await WhiteLabel.findById(whitelabelId);

    if (!whiteLabel || !whiteLabel.isActive) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    // Generuj CSS z brandingiem
    const customCSS = whiteLabelService.generateCustomCSS(whiteLabel.branding);
    const additionalCSS = whiteLabel.ui.customCss || '';

    res.setHeader('Content-Type', 'text/css');
    res.send(customCSS + '\n' + additionalCSS);
  } catch (error) {
    console.error('GET_WHITELABEL_CSS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania CSS' });
  }
});

// POST /api/whitelabel/:whitelabelId/activate - Aktywuj white-label (admin)
router.post('/:whitelabelId/activate', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { whitelabelId } = req.params;

    const whiteLabel = await WhiteLabel.findById(whitelabelId);

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    whiteLabel.isActive = true;
    whiteLabel.status = 'active';
    await whiteLabel.save();

    res.json({
      message: 'White-label aktywowany',
      whiteLabel: {
        _id: whiteLabel._id,
        name: whiteLabel.name,
        slug: whiteLabel.slug,
        status: whiteLabel.status,
        isActive: whiteLabel.isActive
      }
    });
  } catch (error) {
    console.error('ACTIVATE_WHITELABEL_ERROR:', error);
    res.status(500).json({ message: 'Błąd aktywacji white-label' });
  }
});

// DELETE /api/whitelabel/:whitelabelId - Usuń white-label
router.delete('/:whitelabelId', authMiddleware, async (req, res) => {
  try {
    const { whitelabelId } = req.params;
    const userId = req.user._id;

    const whiteLabel = await WhiteLabel.findOneAndDelete({ 
      _id: whitelabelId, 
      owner: userId 
    });

    if (!whiteLabel) {
      return res.status(404).json({ message: 'White-label nie znaleziony' });
    }

    res.json({ message: 'White-label usunięty' });
  } catch (error) {
    console.error('DELETE_WHITELABEL_ERROR:', error);
    res.status(500).json({ message: 'Błąd usuwania white-label' });
  }
});

module.exports = router;













