const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const NotificationLog = require('../models/NotificationLog');
const EmailTemplate = require('../models/EmailTemplate');
const User = require('../models/User');
const Notification = require('../models/Notification');

// Zabezpieczenie - tylko admin
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/notifications/alerts - Alerty analityczne/systemowe
router.get('/alerts', async (req, res) => {
  try {
    const { limit = 100, offset = 0, alertType = 'funnel_regression', startDate, endDate } = req.query;
    const query = {
      type: 'system_announcement'
    };
    if (alertType) query['metadata.alertType'] = alertType;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const [alerts, total] = await Promise.all([
      Notification.find(query)
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .limit(parseInt(limit, 10))
        .skip(parseInt(offset, 10))
        .lean(),
      Notification.countDocuments(query)
    ]);

    res.json({
      success: true,
      alerts,
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (error) {
    console.error('Error fetching analytics alerts:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania alertów', error: error.message });
  }
});

// GET /api/admin/notifications/logs - Lista wszystkich logów powiadomień
router.get('/logs', async (req, res) => {
  try {
    const { limit = 100, offset = 0, type, channel, status, userId, startDate, endDate } = req.query;
    
    const query = {};
    if (type) query.type = type;
    if (channel) query.channel = channel;
    if (status) query.status = status;
    if (userId) query.user = userId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const [logs, total] = await Promise.all([
      NotificationLog.find(query)
        .populate('user', 'name email phone')
        .populate('templateId', 'name key')
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

// GET /api/admin/notifications/stats - Statystyki powiadomień
router.get('/stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateQuery = {};
    if (startDate || endDate) {
      dateQuery.createdAt = {};
      if (startDate) dateQuery.createdAt.$gte = new Date(startDate);
      if (endDate) dateQuery.createdAt.$lte = new Date(endDate);
    }
    
    const [total, byChannel, byType, byStatus, failed] = await Promise.all([
      NotificationLog.countDocuments(dateQuery),
      NotificationLog.aggregate([
        { $match: dateQuery },
        { $group: { _id: '$channel', count: { $sum: 1 } } }
      ]),
      NotificationLog.aggregate([
        { $match: dateQuery },
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ]),
      NotificationLog.aggregate([
        { $match: dateQuery },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      NotificationLog.countDocuments({ ...dateQuery, status: 'failed' })
    ]);
    
    res.json({
      success: true,
      stats: {
        total,
        byChannel: byChannel.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        byType: byType.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        byStatus: byStatus.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        failed,
        successRate: total > 0 ? ((total - failed) / total * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    console.error('Error fetching notification stats:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania statystyk', error: error.message });
  }
});

// GET /api/admin/notifications/templates - Lista szablonów emaili
router.get('/templates', async (req, res) => {
  try {
    const templates = await EmailTemplate.find({})
      .sort({ category: 1, name: 1 })
      .lean();
    
    res.json({
      success: true,
      templates
    });
  } catch (error) {
    console.error('Error fetching email templates:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania szablonów', error: error.message });
  }
});

// GET /api/admin/notifications/templates/:id - Szczegóły szablonu
router.get('/templates/:id', async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Szablon nie znaleziony' });
    }
    
    res.json({
      success: true,
      template
    });
  } catch (error) {
    console.error('Error fetching email template:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania szablonu', error: error.message });
  }
});

// POST /api/admin/notifications/templates - Utwórz szablon
router.post('/templates', async (req, res) => {
  try {
    const { key, name, subject, htmlBody, textBody, variables, category, description } = req.body;
    
    if (!key || !name || !subject || !htmlBody) {
      return res.status(400).json({ success: false, message: 'Brak wymaganych pól: key, name, subject, htmlBody' });
    }
    
    // Sprawdź czy klucz już istnieje
    const existing = await EmailTemplate.findOne({ key });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Szablon o tym kluczu już istnieje' });
    }
    
    const template = await EmailTemplate.create({
      key,
      name,
      subject,
      htmlBody,
      textBody,
      variables: variables || [],
      category: category || 'other',
      description,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    
    res.status(201).json({
      success: true,
      message: 'Szablon został utworzony',
      template
    });
  } catch (error) {
    console.error('Error creating email template:', error);
    res.status(500).json({ success: false, message: 'Błąd tworzenia szablonu', error: error.message });
  }
});

// PUT /api/admin/notifications/templates/:id - Zaktualizuj szablon
router.put('/templates/:id', async (req, res) => {
  try {
    const { name, subject, htmlBody, textBody, variables, isActive, description } = req.body;
    
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Szablon nie znaleziony' });
    }
    
    if (template.isSystem) {
      return res.status(403).json({ success: false, message: 'Nie można edytować szablonów systemowych' });
    }
    
    if (name) template.name = name;
    if (subject) template.subject = subject;
    if (htmlBody) template.htmlBody = htmlBody;
    if (textBody !== undefined) template.textBody = textBody;
    if (variables) template.variables = variables;
    if (isActive !== undefined) template.isActive = isActive;
    if (description) template.description = description;
    template.updatedBy = req.user._id;
    template.version = (template.version || 1) + 1;
    template.updatedAt = new Date();
    
    await template.save();
    
    res.json({
      success: true,
      message: 'Szablon został zaktualizowany',
      template
    });
  } catch (error) {
    console.error('Error updating email template:', error);
    res.status(500).json({ success: false, message: 'Błąd aktualizacji szablonu', error: error.message });
  }
});

// DELETE /api/admin/notifications/templates/:id - Usuń szablon
router.delete('/templates/:id', async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Szablon nie znaleziony' });
    }
    
    if (template.isSystem) {
      return res.status(403).json({ success: false, message: 'Nie można usunąć szablonów systemowych' });
    }
    
    await EmailTemplate.findByIdAndDelete(req.params.id);
    
    res.json({
      success: true,
      message: 'Szablon został usunięty'
    });
  } catch (error) {
    console.error('Error deleting email template:', error);
    res.status(500).json({ success: false, message: 'Błąd usuwania szablonu', error: error.message });
  }
});

module.exports = router;

