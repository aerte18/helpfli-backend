?const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const PushSubscription = require('../models/pushSubscription');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const { validate } = require('../middleware/validation');

// Configure VAPID keys for web-push
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('✅ Web-push VAPID keys configured successfully');
  } else {
    console.log('⚠️ Web-push wyłączony - brak VAPID keys');
  }
} catch (error) {
  console.log('⚠️ Web-push wyłączony - błąd konfiguracji VAPID:', error.message);
}

// GET /api/push/config – publiczny klucz
router.get('/config', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe  body: { subscription }
router.post('/subscribe', authMiddleware, validate('pushSubscribe'), async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ message: 'Brak subskrypcji' });
  await PushSubscription.updateOne(
    { endpoint: sub.endpoint },
    { $set: { user: req.user._id, endpoint: sub.endpoint, keys: sub.keys, ua: req.headers['user-agent'] || '' } },
    { upsert: true }
  );
  res.json({ ok: true });
});

// POST /api/push/unsubscribe  body: { endpoint }
router.post('/unsubscribe', authMiddleware, async (req, res) => {
  const ep = req.body?.endpoint;
  if (!ep) return res.status(400).json({ message: 'Brak endpointu' });
  await PushSubscription.deleteOne({ endpoint: ep, user: req.user._id });
  res.json({ ok: true });
});

// POST /api/push/test – wyślij test do bieżącego usera
router.post('/test', authMiddleware, async (req, res) => {
  const subs = await PushSubscription.find({ user: req.user._id });
  const payload = JSON.stringify({
    title: 'Helpfli • Powiadomienia działają',
    body: 'To jest test web-push ✅',
    url: process.env.APP_URL || 'http://localhost:5173'
  });
  const results = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
      results.push({ endpoint: s.endpoint, ok: true });
    } catch (e) {
      results.push({ endpoint: s.endpoint, ok: false, error: e.message });
      if (e.statusCode === 410 || e.statusCode === 404) {
        await PushSubscription.deleteOne({ _id: s._id });
      }
    }
  }
  res.json({ sent: results.length, results });
});

// ADMIN: broadcast
// POST /api/push/admin/broadcast  body: { title, body, url }
router.post('/admin/broadcast', authMiddleware, requireRole('admin'), async (req, res) => {
  const { title='Helpfli', body='Powiadomienie', url } = req.body || {};
  const subs = await PushSubscription.find({});
  const payload = JSON.stringify({ title, body, url: url || (process.env.APP_URL || 'http://localhost:5173') });
  let ok = 0;

  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
      ok++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await PushSubscription.deleteOne({ _id: s._id });
      }
    }
  }));

  res.json({ sent: ok, total: subs.length });
});

module.exports = router;
