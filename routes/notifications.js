const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const NotificationLog = require('../models/NotificationLog');
const EmailTemplate = require('../models/EmailTemplate');
const Notification = require('../models/Notification');

// GET /api/notifications/preferences - Pobierz preferencje powiadomień użytkownika
router.get('/preferences', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({
      success: true,
      preferences: user.notificationPreferences || {
        subscriptionExpiry: { email: true, sms: false, push: true, daysBefore: [7, 3, 1] },
        promoExpiring: { email: true, sms: false, push: true },
        orderUpdates: { email: true, sms: false, push: true },
        paymentUpdates: { email: true, sms: false, push: true },
        marketing: { email: false, sms: false }
      }
    });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania preferencji', error: error.message });
  }
});

// PUT /api/notifications/preferences - Zaktualizuj preferencje powiadomień
router.put('/preferences', authMiddleware, async (req, res) => {
  try {
    const { preferences } = req.body;
    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'Użytkownik nie znaleziony' });
    }
    
    // Aktualizuj preferencje
    user.notificationPreferences = {
      ...user.notificationPreferences,
      ...preferences
    };
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Preferencje powiadomień zostały zaktualizowane',
      preferences: user.notificationPreferences
    });
  } catch (error) {
    console.error('Error updating notification preferences:', error);
    res.status(500).json({ success: false, message: 'Błąd aktualizacji preferencji', error: error.message });
  }
});

// GET /api/notifications/unread/count - Pobierz liczbę nieprzeczytanych powiadomień
router.get('/unread/count', authMiddleware, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      user: req.user._id,
      read: false
    });
    
    res.json({ count });
  } catch (error) {
    console.error('Error fetching unread notifications count:', error);
    res.status(500).json({ message: 'Błąd pobierania liczby powiadomień', error: error.message });
  }
});

// GET /api/notifications - Pobierz listę powiadomień użytkownika
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { limit = 20, offset = 0, read } = req.query;
    
    const query = { user: req.user._id };
    if (read !== undefined) {
      query.read = read === 'true';
    }
    
    console.log('GET /api/notifications - User ID:', req.user._id, 'Type:', typeof req.user._id);
    console.log('GET /api/notifications - Query:', JSON.stringify(query));
    
    // Sprawdź czy są jakieś powiadomienia dla tego użytkownika
    const allNotificationsForUser = await Notification.find({ user: req.user._id }).limit(5).lean();
    console.log('GET /api/notifications - All notifications for user:', allNotificationsForUser.length);
    if (allNotificationsForUser.length > 0) {
      console.log('GET /api/notifications - Sample notification user ID:', allNotificationsForUser[0].user, 'Type:', typeof allNotificationsForUser[0].user);
      console.log('GET /api/notifications - IDs match:', String(req.user._id) === String(allNotificationsForUser[0].user));
    }
    
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit, 10))
        .skip(parseInt(offset, 10))
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ user: req.user._id, read: false })
    ]);
    
    console.log('GET /api/notifications - Found:', notifications.length, 'notifications');
    console.log('GET /api/notifications - Unread count:', unreadCount);
    
    res.json({
      notifications,
      pagination: {
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        unreadCount
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Błąd pobierania powiadomień', error: error.message });
  }
});

// PUT /api/notifications/:id/read - Oznacz powiadomienie jako przeczytane
router.put('/:id/read', authMiddleware, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { 
        read: true,
        readAt: new Date()
      },
      { new: true }
    );
    
    if (!notification) {
      return res.status(404).json({ message: 'Powiadomienie nie znalezione' });
    }
    
    res.json({ success: true, notification });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: 'Błąd oznaczania powiadomienia', error: error.message });
  }
});

// PUT /api/notifications/read-all - Oznacz wszystkie powiadomienia jako przeczytane
router.put('/read-all', authMiddleware, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { user: req.user._id, read: false },
      { 
        read: true,
        readAt: new Date()
      }
    );
    
    res.json({ 
      success: true, 
      updated: result.modifiedCount 
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: 'Błąd oznaczania powiadomień', error: error.message });
  }
});

// GET /api/notifications/logs - Pobierz logi powiadomień użytkownika
router.get('/logs', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type, channel, status } = req.query;
    
    const query = { user: req.user._id };
    if (type) query.type = type;
    if (channel) query.channel = channel;
    if (status) query.status = status;
    
    const [logs, total] = await Promise.all([
      NotificationLog.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit, 10))
        .skip(parseInt(offset, 10))
        .lean(),
      NotificationLog.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      logs,
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (error) {
    console.error('Error fetching notification logs:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania logów', error: error.message });
  }
});

module.exports = router;
