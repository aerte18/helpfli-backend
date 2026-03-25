const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const Order = require('../models/Order');
const { buildHtml, renderPdfFromHtml, buildHtmlPerCity, buildHtmlPerService } = require('../utils/pdf_report');
const Service = require('../models/Service');
const SettingsModel = require('../models/Settings');
const { recordReportLog } = require('../utils/report_logs');

// GET /api/admin/reports/monthly.pdf?month=YYYY-MM
router.get('/monthly.pdf', authMiddleware, requireRole('admin'), async (req, res) => {
  const m = req.query.month || dayjs().format('YYYY-MM');
  const start = dayjs(m + '-01').startOf('month');
  const end   = start.endOf('month');

  const [ordersAll, ordersPaid, revenueAgg] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() } }),
    Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() }, paidInSystem: true, paymentStatus: 'succeeded' }),
    Order.aggregate([
      { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, paidInSystem: true, paymentStatus: 'succeeded' } },
      { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
    ])
  ]);
  const revenue = revenueAgg[0]?.sum || 0;

  const daily = await Order.aggregate([
    { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
    { $project: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] },
        rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] },
    }},
    { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
    { $sort: { _id: 1 } }
  ]);

  const topServices = await Order.aggregate([
    { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
    { $group: { _id: '$service', count: { $sum: 1 },
                paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]);

  const kpi = { orders: ordersAll, ordersPaid, revenue, avgOrder: (ordersPaid ? Math.round(revenue / ordersPaid) : 0) };

  const html = buildHtml({
    title: `Helpfli – Raport miesięczny ${m}`,
    range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') },
    kpi, daily, topServices,
    brand: { name: process.env.BRAND_NAME || 'Helpfli', primary: process.env.BRAND_PRIMARY || '#7c3aed', logoUrl: process.env.BRAND_LOGO_URL || '' }
  });

  const pdf = await renderPdfFromHtml(html);
  const fname = `helpfli_monthly_${m}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(pdf);
});

module.exports = router;
// GET /api/admin/reports/monthly_cities.pdf?month=YYYY-MM&limit=10
router.get('/monthly_cities.pdf', authMiddleware, requireRole('admin'), async (req, res) => {
  const m = req.query.month || dayjs().format('YYYY-MM');
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
  const start = dayjs(m + '-01').startOf('month');
  const end   = start.endOf('month');

  const topCities = await Order.aggregate([
    { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
    { $group: { _id: '$city', revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } }, orders: { $sum: 1 } }},
    { $sort: { revenue: -1, orders: -1 } },
    { $limit: limit }
  ]);

  const cities = [];
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
        { $project: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] },
            rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] },
        }},
        { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
        { $sort: { _id: 1 } }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, city } },
        { $group: { _id: '$service', count: { $sum: 1 },
                    paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                    revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
    ]);

    const revenue = revenueAgg[0]?.sum || 0;
    const kpi = { orders: ordersAll, ordersPaid, revenue, paidShare: ordersAll ? (ordersPaid / ordersAll) : 0 };
    cities.push({ city, kpi, daily, topServices });
  }

  const html = buildHtmlPerCity({ title: `Helpfli – Raport miesięczny per miasto ${m}`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, cities });
  const pdf = await renderPdfFromHtml(html);
  const fname = `helpfli_monthly_cities_${m}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(pdf);
});

// GET /api/admin/reports/monthly_services.pdf?month=YYYY-MM&limit=15&lang=pl
router.get('/monthly_services.pdf', authMiddleware, requireRole('admin'), async (req, res) => {
  const m = req.query.month || dayjs().format('YYYY-MM');
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 60);
  const lang = (req.query.lang || 'pl').toLowerCase();
  const start = dayjs(m + '-01').startOf('month');
  const end   = start.endOf('month');

  const svcDocs = await Service.find({}).select('_id code name').lean();
  const nameById = Object.fromEntries(svcDocs.map(s => [String(s._id), s.name || s.code]));
  const nameByCode = Object.fromEntries(svcDocs.map(s => [String(s.code), s.name || s.code]));

  const topServices = await Order.aggregate([
    { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
    { $group: { _id: '$service', revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } }, orders: { $sum: 1 } }},
    { $sort: { revenue: -1, orders: -1 } },
    { $limit: limit }
  ]);

  const services = [];
  for (const s of topServices) {
    const key = s._id;
    const matchSvc = { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, service: key };

    const [ordersAll, ordersPaid, revenueAgg, daily, topCities] = await Promise.all([
      Order.countDocuments(matchSvc),
      Order.countDocuments({ ...matchSvc, paidInSystem: true, paymentStatus: 'succeeded' }),
      Order.aggregate([
        { $match: { ...matchSvc, paidInSystem: true, paymentStatus: 'succeeded' } },
        { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
      ]),
      Order.aggregate([
        { $match: matchSvc },
        { $project: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] },
            rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] },
        }},
        { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
        { $sort: { _id: 1 } }
      ]),
      Order.aggregate([
        { $match: matchSvc },
        { $group: { _id: '$city', count: { $sum: 1 }, revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
        { $sort: { revenue: -1, count: -1 } },
        { $limit: 10 }
      ]),
    ]);

    const revenue = revenueAgg[0]?.sum || 0;
    const name = nameById[String(key)] || nameByCode[String(key)] || String(key);

    services.push({ key: String(key), name, kpi: { orders: ordersAll, paidOrders: ordersPaid, revenue, systemShare: ordersAll ? (ordersPaid / ordersAll) : 0 }, daily, topCities });
  }

  const brand = { name: process.env.BRAND_NAME || 'Helpfli', primary: process.env.BRAND_PRIMARY || '#7c3aed', logoUrl: process.env.BRAND_LOGO_URL || '' };

  const html = buildHtmlPerService({ title: `Helpfli — ${(lang==='en'?'Monthly Report by Service':'Raport miesięczny per usługa')} ${m}`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, services, brand, lang });
  const pdf = await renderPdfFromHtml(html);
  const fname = `helpfli_monthly_services_${m}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(pdf);
});

// POST /api/admin/reports/monthly_services/send-now?month=YYYY-MM&limit=10&lang=pl
router.post('/monthly_services/send-now', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const m = req.query.month || dayjs().format('YYYY-MM');
    const doc = await SettingsModel.findOne({ key: 'monthlyServiceReports' }).lean();
    const v = doc?.value || {};
    const limit = Math.min(parseInt(req.query.limit || v.limit || process.env.MONTHLY_SERVICES_LIMIT || '10', 10), 60);
    const lang = (req.query.lang || v.lang || process.env.MONTHLY_SERVICES_LANG || 'pl').toLowerCase();
    const recipients = (v.recipients || (process.env.ADMIN_REPORT_EMAILS || '')).trim();

    const { services, start, end } = await require('../jobs/monthly_services_report').buildServiceCards(m, limit, lang);
    const brand = { name: process.env.BRAND_NAME || 'Helpfli', primary: process.env.BRAND_PRIMARY || '#7c3aed', logoUrl: process.env.BRAND_LOGO_URL || '' };
    const attachments = [];

    if (v.separate !== false) {
      for (const svc of services) {
        const html = buildHtmlPerService({ title:`Helpfli — Raport per usługa ${m} — ${svc.name}`, range:{ from:start.format('YYYY-MM-DD'), to:end.format('YYYY-MM-DD') }, services:[svc], brand, lang });
        const pdf = await renderPdfFromHtml(html);
        attachments.push({ filename: `helpfli_service_${svc.name}_${m}.pdf`, content: pdf });
      }
    }
    if (v.includeCombined !== false) {
      const htmlAll = buildHtmlPerService({ title:`Helpfli — Raport per usługa ${m} (Top ${limit})`, range:{ from:start.format('YYYY-MM-DD'), to:end.format('YYYY-MM-DD') }, services, brand, lang });
      attachments.push({ filename: `helpfli_monthly_services_${m}.pdf`, content: await renderPdfFromHtml(htmlAll) });
    }

    if (recipients) {
      const mail = await require('../utils/email').sendMail({ to: recipients, subject: `Helpfli — Raport per usługa ${m}`, html: `<p>W załączniku raporty per usługa (Top ${limit}).</p>`, attachments });
      await recordReportLog({ type: 'monthly_services_batch', month: m, recipients: recipients.split(',').map(s=>s.trim()).filter(Boolean), attachments, status: mail.ok ? 'sent' : 'failed', settings: { limit, lang, separate: v.separate !== false, includeCombined: v.includeCombined !== false }, trigger: 'manual', triggeredBy: req.user._id, error: mail.ok ? '' : (mail.reason || 'email_failed') });
    }

    res.json({ ok: true, sent: attachments.length, recipients });
  } catch (e) {
    console.error('send-now error', e);
    res.status(500).json({ message: 'Błąd wysyłki' });
  }
});

module.exports = router;
