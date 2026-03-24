const cron = require('node-cron');
const dayjs = require('dayjs');
const { buildHtml } = require('../utils/pdf_report');
const Order = require('../models/Order');
const User = require('../models/User');
const PushSubscription = require('../models/pushSubscription');
const webpush = require('web-push');
const { sendMail } = require('../utils/email');
const { recordReportLog } = require('../utils/report_logs');

const TZ = process.env.REPORTS_TZ || 'Europe/Warsaw';

// webpush.setVapidDetails(
//   process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
//   process.env.VAPID_PUBLIC_KEY,
//   process.env.VAPID_PRIVATE_KEY
// );

async function notifyAdminsPush(payload) {
  const admins = await User.find({ role: 'admin' }).select('_id').lean();
  const subs = await PushSubscription.find({ user: { $in: admins.map(a => a._id) } });
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode===410||e.statusCode===404) await PushSubscription.deleteOne({ _id: s._id }); }
  }
}

async function buildMonthlySummary(monthStr) {
  const start = dayjs(monthStr + '-01').startOf('month');
  const end   = start.endOf('month');

  const [ordersAll, ordersPaid, revenueAgg, daily, topServices] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() } }),
    Order.countDocuments({ createdAt: { $gte: start.toDate(), $lte: end.toDate() }, paidInSystem: true, paymentStatus: 'succeeded' }),
    Order.aggregate([
      { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() }, paidInSystem: true, paymentStatus: 'succeeded' } },
      { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
      { $project: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] },
          rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] },
      }},
      { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
      { $sort: { _id: 1 } }
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: start.toDate(), $lte: end.toDate() } } },
      { $group: { _id: '$service', count: { $sum: 1 },
                  paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                  revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]),
  ]);
  const kpi = {
    orders: ordersAll,
    ordersPaid,
    revenue: revenueAgg[0]?.sum || 0,
    avgOrder: (ordersPaid ? Math.round((revenueAgg[0]?.sum || 0)/ordersPaid) : 0)
  };
  return { start, end, kpi, daily, topServices };
}

function startMonthlyReport() {
  if (String(process.env.ENABLE_MONTHLY_REPORTS || 'false') !== 'true') return;
  const spec = process.env.MONTHLY_CRON || '5 9 1 * *';

  cron.schedule(spec, async () => {
    try {
      const lastMonth = dayjs().subtract(1, 'month').format('YYYY-MM');
      const { start, end, kpi, daily, topServices } = await buildMonthlySummary(lastMonth);
      const html = buildHtml({
        title: `Helpfli – Raport miesięczny ${lastMonth}`,
        range: { from: start.format('YYYY-MM-DD'), to: end.format('YYYY-MM-DD') },
        kpi, daily, topServices
      });
      const pdf = await renderPdfFromHtml(html);

      await notifyAdminsPush({
        title: 'Helpfli – Raport miesięczny',
        body: `Okres ${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')} | Zlecenia: ${kpi.orders}, Obrót: ${(kpi.revenue/100).toFixed(2)} PLN`,
        url: `${process.env.APP_URL}/admin/analytics`
      });

      const recipients = (process.env.ADMIN_REPORT_EMAILS || '').trim();
      if (recipients) {
        const mail = await sendMail({
          to: recipients,
          subject: `Helpfli – Raport miesięczny ${lastMonth}`,
          html: `<p>W załączniku raport miesięczny (${lastMonth}).</p>`,
          attachments: [{ filename: `helpfli_monthly_${lastMonth}.pdf`, content: pdf }]
        });
        await recordReportLog({
          type: 'monthly_global',
          month: lastMonth,
          recipients: recipients.split(',').map(s=>s.trim()).filter(Boolean),
          attachments: [{ filename: `helpfli_monthly_${lastMonth}.pdf`, size: pdf.length }],
          status: mail.ok ? 'sent' : 'failed',
          settings: {}, trigger: 'cron', triggeredBy: null,
          error: mail.ok ? '' : (mail.reason || 'email_failed')
        });
      }
    } catch (e) {
      console.error('[monthly_report] error', e);
    }
  }, { timezone: process.env.REPORTS_TZ || 'Europe/Warsaw' });

  console.log('[cron] Monthly PDF scheduled:', spec);
}

module.exports = { startMonthlyReport };
