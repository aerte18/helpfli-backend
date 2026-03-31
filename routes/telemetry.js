const express = require('express');
const router = express.Router();
const TelemetryService = require('../services/TelemetryService');
const { authMiddleware } = require('../middleware/authMiddleware');
const { validateTelemetry } = require('../middleware/inputValidator');
const Notification = require('../models/Notification');
const User = require('../models/User');

const FUNNEL_SEQUENCE = [
  'page_view',
  'search',
  'provider_view',
  'provider_contact',
  'order_form_start',
  'order_form_success',
  'payment_succeeded'
];

function getWorstFunnelDrop(items = []) {
  const byType = Object.fromEntries((items || []).map((i) => [i._id, i.count || 0]));
  let prev = null;
  let worst = null;
  for (const key of FUNNEL_SEQUENCE) {
    const current = byType[key] || 0;
    if (prev !== null && prev > 0) {
      const dropPct = ((prev - current) / prev) * 100;
      if (!worst || dropPct > worst.dropPct) {
        worst = { from: prev, to: current, step: key, dropPct };
      }
    }
    if (current > 0) prev = current;
  }
  return worst;
}

async function maybeCreateFunnelRegressionAlert({ startDate, endDate, roleLabel, funnelData, threshold = 35 }) {
  const worst = getWorstFunnelDrop(funnelData);
  if (!worst || worst.dropPct < threshold) return;

  const alertKey = `funnel_regression:${roleLabel}:${startDate.toISOString()}:${endDate.toISOString()}:${worst.step}`;
  const existing = await Notification.findOne({
    type: 'system_announcement',
    'metadata.alertKey': alertKey,
    createdAt: { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) }
  }).lean();
  if (existing) return;

  const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  if (!admins.length) return;

  const title = `Alert regresji lejka (${roleLabel})`;
  const message = `Wykryto spadek ${worst.dropPct.toFixed(1)}% na kroku "${worst.step}" w zakresie ${startDate.toISOString().slice(0, 10)} - ${endDate.toISOString().slice(0, 10)}.`;

  await Notification.insertMany(
    admins.map((admin) => ({
      user: admin._id,
      type: 'system_announcement',
      title,
      message,
      link: '/admin/analytics',
      metadata: {
        alertKey,
        alertType: 'funnel_regression',
        roleLabel,
        threshold,
        dropPct: Number(worst.dropPct.toFixed(2)),
        step: worst.step,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      }
    }))
  );
}

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

    const funnel = await TelemetryService.getConversionFunnelDetailed(
      new Date(startDate),
      new Date(endDate)
    );

    const start = new Date(startDate);
    const end = new Date(endDate);
    await Promise.all([
      maybeCreateFunnelRegressionAlert({ startDate: start, endDate: end, roleLabel: 'overall', funnelData: funnel.overall }),
      maybeCreateFunnelRegressionAlert({ startDate: start, endDate: end, roleLabel: 'client', funnelData: funnel.client }),
      maybeCreateFunnelRegressionAlert({ startDate: start, endDate: end, roleLabel: 'provider', funnelData: funnel.provider })
    ]);

    res.json(funnel);
  } catch (error) {
    console.error('Telemetry funnel error:', error);
    res.status(500).json({ message: 'Błąd pobierania funnela konwersji' });
  }
});

module.exports = router;
