const express = require('express');
const router = express.Router();
const TelemetryService = require('../services/TelemetryService');
const { authMiddleware } = require('../middleware/authMiddleware');
const { validateTelemetry } = require('../middleware/inputValidator');

// POST /api/telemetry/track - śledzenie eventów
router.post('/track', authMiddleware, validateTelemetry, async (req, res) => {
  try {
    const { eventType, properties = {}, metadata = {} } = req.body;
    const userId = req.user._id;
    const sessionId = req.headers['x-session-id'] || null;
    
    // Walidacja eventType
    if (!Object.values(TelemetryService.eventTypes).includes(eventType)) {
      return res.status(400).json({ message: 'Nieprawidłowy typ eventu' });
    }

    await TelemetryService.track(eventType, {
      userId,
      sessionId,
      properties,
      metadata,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      referrer: req.headers.referer
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Telemetry tracking error:', error);
    res.status(500).json({ message: 'Błąd śledzenia eventu' });
  }
});

// POST /api/telemetry/batch - śledzenie wielu eventów naraz
router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const { events } = req.body;
    const userId = req.user._id;
    const sessionId = req.headers['x-session-id'] || null;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ message: 'Lista eventów jest wymagana' });
    }

    // Limit na batch size
    if (events.length > 50) {
      return res.status(400).json({ message: 'Maksymalnie 50 eventów na raz' });
    }

    const promises = events.map(event => {
      const { eventType, properties = {}, metadata = {} } = event;
      
      if (!Object.values(TelemetryService.eventTypes).includes(eventType)) {
        return Promise.resolve(); // Pomiń nieprawidłowe eventy
      }

      return TelemetryService.track(eventType, {
        userId,
        sessionId,
        properties,
        metadata,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        referrer: req.headers.referer
      });
    });

    await Promise.all(promises);
    res.json({ success: true, tracked: events.length });
  } catch (error) {
    console.error('Telemetry batch error:', error);
    res.status(500).json({ message: 'Błąd śledzenia eventów' });
  }
});

// GET /api/telemetry/stats - statystyki (tylko dla adminów)
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    // Sprawdź czy użytkownik to admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const { eventType, startDate, endDate } = req.query;
    
    if (!eventType || !startDate || !endDate) {
      return res.status(400).json({ message: 'eventType, startDate i endDate są wymagane' });
    }

    const stats = await TelemetryService.getEventStats(
      eventType,
      new Date(startDate),
      new Date(endDate)
    );

    res.json(stats);
  } catch (error) {
    console.error('Telemetry stats error:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

// GET /api/telemetry/pages - popularne strony (tylko dla adminów)
router.get('/pages', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const { startDate, endDate, limit = 10 } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate i endDate są wymagane' });
    }

    const pages = await TelemetryService.getPopularPages(
      new Date(startDate),
      new Date(endDate),
      parseInt(limit)
    );

    res.json(pages);
  } catch (error) {
    console.error('Telemetry pages error:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk stron' });
  }
});

// GET /api/telemetry/funnel - funnel konwersji (tylko dla adminów)
router.get('/funnel', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate i endDate są wymagane' });
    }

    const funnel = await TelemetryService.getConversionFunnel(
      new Date(startDate),
      new Date(endDate)
    );

    res.json(funnel);
  } catch (error) {
    console.error('Telemetry funnel error:', error);
    res.status(500).json({ message: 'Błąd pobierania funnela konwersji' });
  }
});

module.exports = router;
