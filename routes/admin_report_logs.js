const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const ReportLog = require('../models/reportLog');
const { sendMail } = require('../utils/email');
const { buildHtml, buildHtmlPerCity, buildHtmlPerService, renderPdfFromHtml } = require('../utils/pdf_report');
const Order = require('../models/Order');
const { buildServiceCards } = require('../jobs/monthly_services_report');
const { remember, set } = require('../utils/cache');

// GET /api/admin/reports/logs?type=&month=&status=&page=1&limit=20
router.get('/logs', authMiddleware, requireRole('admin'), async (req, res) => {
  const q = {};
  if (req.query.type) q.type = req.query.type;
  if (req.query.month) q.month = req.query.month;
  if (req.query.status) q.status = req.query.status;

  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    ReportLog.find(q).populate('triggeredBy','name email').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ReportLog.countDocuments(q)
  ]);

  res.json({ total, page, pages: Math.ceil(total/limit), items });
});

// POST /api/admin/reports/logs/:id/resend  (?recipients=a@b,c@d)
router.post('/logs/:id/resend', authMiddleware, requireRole('admin'), async (req, res) => {
  const log = await ReportLog.findById(req.params.id);
  if (!log) return res.status(404).json({ message: 'Nie znaleziono logu' });

  const recipientsStr = (req.query.recipients || '').trim();
  const recipients = recipientsStr ? recipientsStr.split(',').map(s => s.trim()).filter(Boolean) : (log.recipients || []);
  if (!recipients.length) return res.status(400).json({ message: 'Brak odbiorców (podaj ?recipients=...)' });

  const month = log.month;
  const brand = { name: process.env.BRAND_NAME || 'Helpfli', primary: process.env.BRAND_PRIMARY || '#7c3aed', logoUrl: process.env.BRAND_LOGO_URL || '' };

  try {
    let attachments = [];

    if (log.type === 'monthly_global') {
      const start = dayjs(month + '-01').startOf('month');
      const end = start.endOf('month');

      const aggKey = `preview:global:${month}`;
      const nocache = req.query.nocache === '1';
      let payload = null;
      if (!nocache) {
        payload = await remember(aggKey, 600, async () => null);
      }
      let ordersAll, ordersPaid, revenue, daily, topServices;
      if (payload) {
        ({ ordersAll, ordersPaid, revenue, daily, topServices } = payload);
      } else {
        const [oAll, oPaid, revAgg] = await Promise.all([
          Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() } }),
          Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() }, paidInSystem: true, paymentStatus: 'succeeded' }),
          Order.aggregate([
            { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, paidInSystem: true, paymentStatus: 'succeeded' } },
            { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
          ])
        ]);
        ordersAll = oAll; ordersPaid = oPaid; revenue = revAgg[0]?.sum || 0;
        daily = await Order.aggregate([
          { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
          { $project: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] }, rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] }, }},
          { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
          { $sort: { _id: 1 } }
        ]);
        topServices = await Order.aggregate([
          { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
          { $group: { _id: '$service', count: { $sum: 1 },
                      paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                      revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
          { $sort: { count: -1 } },
          { $limit: 20 }
        ]);
        if (!nocache) await set(aggKey, { ordersAll, ordersPaid, revenue, daily, topServices }, 600);
      }
      const kpi = { orders: ordersAll, ordersPaid, revenue, avgOrder: (ordersPaid ? Math.round(revenue/ordersPaid) : 0) };
      const html = buildHtml({ title: `Helpfli – Raport miesięczny ${month}`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, kpi, daily, topServices, brand, lang: 'pl' });
      const pdf = await renderPdfFromHtml(html);
      attachments.push({ filename: `helpfli_monthly_${month}.pdf`, content: pdf, size: pdf.length });

    } else if (log.type === 'monthly_cities') {
      const start = dayjs(month + '-01').startOf('month');
      const end = start.endOf('month');
      const limit = Math.min(parseInt(log.settings?.limit || '10', 10), 50);
      const aggKey = `preview:cities:${month}:${limit}`;
      const nocache = req.query.nocache === '1';
      let payload = null;
      if (!nocache) {
        payload = await remember(aggKey, 900, async () => null);
      }
      let cities;
      if (payload) {
        cities = payload.cities;
      } else {
        const topCities = await Order.aggregate([
          { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
          { $group: { _id: '$city', revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } }, orders: { $sum: 1 } }},
          { $sort: { revenue: -1, orders: -1 } },
          { $limit: limit }
        ]);
        cities = [];
        for (const c of topCities) {
          const city = c._id || '—';
          const [ordersAll, ordersPaid, revenueAgg, daily, topServices] = await Promise.all([
            Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() }, city }),
            Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() }, city, paidInSystem: true, paymentStatus: 'succeeded' }),
            Order.aggregate([
              { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, city, paidInSystem: true, paymentStatus: 'succeeded' } },
              { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
            ]),
            Order.aggregate([
              { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, city } },
              { $project: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] }, rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] }, }},
              { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
              { $sort: { _id: 1 } }
            ]),
            Order.aggregate([
              { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, city } },
              { $group: { _id: '$service', count: { $sum: 1 }, paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } }, revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
              { $sort: { count: -1 } },
              { $limit: 10 }
            ]),
          ]);
          const revenue = revenueAgg[0]?.sum || 0;
          cities.push({ city, kpi: { orders: ordersAll, ordersPaid, revenue, paidShare: ordersAll ? (ordersPaid/ordersAll) : 0 }, daily, topServices });
        }
        if (!nocache) await set(aggKey, { cities }, 900);
      }
      const html = buildHtmlPerCity({ title: `Helpfli – Raport miesięczny per miasto ${month}`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, cities });
      const pdf = await renderPdfFromHtml(html);
      attachments.push({ filename: `helpfli_monthly_cities_${month}.pdf`, content: pdf, size: pdf.length });

    } else if (log.type === 'monthly_services_batch') {
      const variant = (req.query.variant || 'combined').toLowerCase();
      const limit = Math.min(parseInt(log.settings?.limit || '10', 10), 60);
      const lang = (log.settings?.lang || 'pl').toLowerCase();
      const brand = { name: process.env.BRAND_NAME || 'Helpfli', primary: process.env.BRAND_PRIMARY || '#7c3aed', logoUrl: process.env.BRAND_LOGO_URL || '' };
      const { services, start, end } = await buildServiceCards(month, limit, lang);

      if (variant === 'single') {
        const key = req.query.serviceKey;
        if (!key) return res.status(400).json({ message: 'Brak parametru serviceKey' });
        let svc = services.find(s => String(s.key) === String(key));
        if (!svc) svc = services.find(s => (s.name || '').toLowerCase() === String(key).toLowerCase());
        if (!svc) return res.status(404).json({ message: 'Nie znaleziono usługi w tym logu/miesiącu' });
        const html = buildHtmlPerService({ title: `Helpfli — ${lang==='en'?'Monthly Report by Service':'Raport miesięczny per usługa'} ${month} — ${svc.name}`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, services: [svc], brand, lang });
        const pdf = await renderPdfFromHtml(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="helpfli_service_${svc.name}_${month}.pdf"`);
        return res.send(pdf);
      }

      const htmlAll = buildHtmlPerService({ title: `Helpfli — ${(lang==='en'?'Monthly Report by Service':'Raport miesięczny per usługa')} ${month} (Top ${limit})`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, services, brand, lang });
      const pdf = await renderPdfFromHtml(htmlAll);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="helpfli_monthly_services_${month}.pdf"`);
      return res.send(pdf);
    }

    if (!attachments.length) return res.status(400).json({ message: 'Nieobsługiwany typ logu' });
    const file = attachments[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    return res.send(file.content);
  } catch (e) {
    console.error('preview error', e);
    return res.status(500).json({ message: 'Błąd generowania podglądu', error: e.message });
  }
});

// GET /api/admin/reports/logs/:id/services?limit=50
router.get('/logs/:id/services', authMiddleware, requireRole('admin'), async (req, res) => {
  const log = await ReportLog.findById(req.params.id).lean();
  if (!log) return res.status(404).json({ message: 'Nie znaleziono logu' });
  if (log.type !== 'monthly_services_batch') return res.status(400).json({ message: 'Ten typ logu nie ma listy usług' });

  const start = dayjs(log.month + '-01').startOf('month');
  const end = start.endOf('month');
  const limit = Math.min(parseInt(req.query.limit || log.settings?.limit || '20', 10), 100);

  const cacheKey = `svcList:${log._id}:${limit}`;
  const payload = await remember(cacheKey, 600, async () => {
    const Service = require('../models/Service');
    const svcDocs = await Service.find({}).select('_id code name').lean();
    const nameById = Object.fromEntries(svcDocs.map(s => [String(s._id), s.name || s.code]));
    const nameByCode = Object.fromEntries(svcDocs.map(s => [String(s.code), s.name || s.code]));

    const agg = await Order.aggregate([
      { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
      { $group: { _id: '$service', orders: { $sum: 1 }, revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
      { $sort: { revenue: -1, orders: -1 } },
      { $limit: limit }
    ]);

    const items = agg.map(a => {
      const key = String(a._id);
      const name = nameById[key] || nameByCode[key] || key;
      return { key, name, orders: a.orders, revenuePLN: Math.round((a.revenue || 0))/100 };
    });

    return { month: log.month, items };
  });

  res.json(payload);
});

module.exports = router;
