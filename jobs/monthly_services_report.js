const cron = require('node-cron');
const dayjs = require('dayjs');
const Order = require('../models/Order');
const Service = require('../models/Service');
const Settings = require('../models/Settings');
const { buildHtmlPerService } = require('../utils/pdf_report');
const { sendMail } = require('../utils/email');
const { recordReportLog } = require('../utils/report_logs');
const { remember } = require('../utils/cache');
const User = require('../models/User');
const PushSubscription = require('../models/pushSubscription');
const webpush = require('web-push');

// webpush.setVapidDetails(
//   process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
//   process.env.VAPID_PUBLIC_KEY,
//   process.env.VAPID_PRIVATE_KEY
// );

async function notifyAdminsPush(body) {
  const admins = await User.find({ role: 'admin' }).select('_id').lean();
  const subs = await PushSubscription.find({ user: { $in: admins.map(a => a._id) } });
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title:'Helpfli – Raport per usługa', body, url: `${process.env.APP_URL}/admin/analytics` })); }
    catch (e) { if (e.statusCode===410||e.statusCode===404) await PushSubscription.deleteOne({ _id: s._id }); }
  }
}

async function buildServiceCards(monthStr, limit, lang) {
  const cacheKey = `svcCards:${monthStr}:${limit}:${lang}`;
  return await remember(cacheKey, 1800, async () => {
    const start = dayjs(monthStr + '-01').startOf('month');
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
      const name = nameById[String(key)] || nameByCode[String(key)] || String(key);
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
          { $project: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] }, rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] }, }},
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
      const prevStart = start.clone().subtract(1,'month');
      const prevEnd = prevStart.endOf('month');
      const matchPrev = { createdAt: { $gte: prevStart.toDate(), $lte: prevEnd.toDate() }, service: key };
      const [po, pp, prevRevAgg] = await Promise.all([
        Order.countDocuments(matchPrev),
        Order.countDocuments({ ...matchPrev, paidInSystem: true, paymentStatus: 'succeeded' }),
        Order.aggregate([
          { $match: { ...matchPrev, paidInSystem: true, paymentStatus: 'succeeded' } },
          { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
        ])
      ]);
      const prevRev = prevRevAgg[0]?.sum || 0;

      services.push({
        key: String(key), name,
        kpi: { orders: ordersAll, paidOrders: ordersPaid, revenue, systemShare: ordersAll ? (ordersPaid / ordersAll) : 0 },
        daily, topCities,
        mom: { orders: { prev: po, curr: ordersAll }, paid: { prev: pp, curr: ordersPaid }, revenue:{ prev: prevRev, curr: revenue }, avg: { prev: (pp ? Math.round(prevRev/pp) : 0), curr: (ordersPaid ? Math.round(revenue/ordersPaid) : 0) } }
      });
    }
    return { services, start, end };
  });
}

function startMonthlyServiceReports() {
  if (String(process.env.ENABLE_MONTHLY_SERVICE_REPORTS || 'false') !== 'true') return;
  const spec = process.env.MONTHLY_SERVICES_CRON || process.env.MONTHLY_CRON || '10 9 1 * *';

  cron.schedule(spec, async () => {
    try {
      const doc = await Settings.findOne({ key: 'monthlyServiceReports' }).lean();
      const v = doc?.value || {};
      const cfg = { enabled: v.enabled !== false, limit: Number.isFinite(v.limit) ? v.limit : parseInt(process.env.MONTHLY_SERVICES_LIMIT || '10', 10), lang: (v.lang || process.env.MONTHLY_SERVICES_LANG || 'pl').toLowerCase(), separate: v.separate !== false, includeCombined: v.includeCombined !== false, recipients: (v.recipients || (process.env.ADMIN_REPORT_EMAILS || '')).trim() };
      if (!cfg.enabled) return;

      const monthStr = dayjs().subtract(1,'month').format('YYYY-MM');
      const { services, start, end } = await buildServiceCards(monthStr, cfg.limit, cfg.lang);

      const brand = { name: process.env.BRAND_NAME || 'Helpfli', primary: process.env.BRAND_PRIMARY || '#7c3aed', logoUrl: process.env.BRAND_LOGO_URL || '' };

      const attachments = [];
      if (cfg.separate) {
        for (const svc of services) {
          const html = buildHtmlPerService({ title: `Helpfli — ${(cfg.lang==='en'?'Monthly Report by Service':'Raport miesięczny per usługa')} ${monthStr} — ${svc.name}`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, services: [svc], brand, lang: cfg.lang });
          const pdf = await renderPdfFromHtml(html);
          attachments.push({ filename: `helpfli_service_${svc.name}_${monthStr}.pdf`, content: pdf });
        }
      }
      if (cfg.includeCombined) {
        const htmlAll = buildHtmlPerService({ title: `Helpfli — ${(cfg.lang==='en'?'Monthly Report by Service':'Raport miesięczny per usługa')} ${monthStr} (Top ${cfg.limit})`, range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') }, services, brand, lang: cfg.lang });
        const pdfAll = await renderPdfFromHtml(htmlAll);
        attachments.push({ filename: `helpfli_monthly_services_${monthStr}.pdf`, content: pdfAll });
      }

      if (cfg.recipients) {
        const mail = await sendMail({ to: cfg.recipients, subject: `Helpfli — Raport per usługa ${monthStr}`, html: `<p>W załączniku raporty per usługa (Top ${cfg.limit}) za ${monthStr}.</p>`, attachments });
        await recordReportLog({ type: 'monthly_services_batch', month: monthStr, recipients: cfg.recipients.split(',').map(s=>s.trim()).filter(Boolean), attachments, status: mail.ok ? 'sent' : 'failed', settings: { limit: cfg.limit, lang: cfg.lang, separate: cfg.separate, includeCombined: cfg.includeCombined }, trigger: 'cron', triggeredBy: null, error: mail.ok ? '' : (mail.reason || 'email_failed') });
      }

      await notifyAdminsPush(`Wysłano raporty per usługa (Top ${cfg.limit}) za ${monthStr}.`);
    } catch (e) {
      console.error('[monthly_services_report] error', e);
    }
  }, { timezone: process.env.REPORTS_TZ || 'Europe/Warsaw' });

  console.log('[cron] Monthly service reports scheduled');
}

module.exports = { startMonthlyServiceReports, buildServiceCards };
