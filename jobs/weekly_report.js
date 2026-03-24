const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(tz);

const Order = require('../models/Order');
const User = require('../models/User');
const PushSubscription = require('../models/pushSubscription');
const webpush = require('web-push');
// const { Parser } = require('json2csv');
const { sendMail } = require('../utils/email');

const TZ = process.env.REPORTS_TZ || 'Europe/Warsaw';
dayjs.tz.setDefault(TZ);

// webpush.setVapidDetails(
//   process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
//   process.env.VAPID_PUBLIC_KEY,
//   process.env.VAPID_PRIVATE_KEY
// );

async function notifyAdminsPush(payload) {
  const admins = await User.find({ role: 'admin' }).select('_id').lean();
  const ids = admins.map(a => a._id);
  const subs = await PushSubscription.find({ user: { $in: ids } });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await PushSubscription.deleteOne({ _id: s._id });
      }
    }
  }
}

async function buildWeeklySummary(from, to) {
  const start = from.startOf('day').toDate();
  const end = to.endOf('day').toDate();

  const [ordersAll, ordersPaid, revenueAgg, providersVerified] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    Order.countDocuments({ createdAt: { $gte: start, $lte: end }, paidInSystem: true, paymentStatus: 'succeeded' }),
    Order.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, paidInSystem: true, paymentStatus: 'succeeded' } },
      { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
    ]),
    User.countDocuments({ role: 'provider', 'kyc.status': 'verified' }),
  ]);

  const revenue = revenueAgg[0]?.sum || 0;

  const daily = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $project: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] },
        rev:  { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] },
    }},
    { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
    { $sort: { _id: 1 } }
  ]);

  const topServices = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: '$service', count: { $sum: 1 },
                paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]);

  return { ordersAll, ordersPaid, revenue, daily, topServices, providersVerified };
}

// function csvFromRows(rows) {
//   const parser = new Parser();
//   return parser.parse(rows);
// }

async function sendWeeklyEmail(from, to, summary) {
  const list = (process.env.ADMIN_REPORT_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!list.length) return { ok:false, reason:'no_recipients' };

  const html = `
    <h2>Helpfli – Raport tygodniowy (${from.format('YYYY-MM-DD')} → ${to.format('YYYY-MM-DD')})</h2>
    <ul>
      <li>Zlecenia: <b>${summary.ordersAll}</b></li>
      <li>Opłacone (w systemie): <b>${summary.ordersPaid}</b></li>
      <li>Obrót: <b>${(summary.revenue/100).toFixed(2)} PLN</b></li>
      <li>Zweryfikowani wykonawcy (KYC): <b>${summary.providersVerified}</b></li>
    </ul>
    <p>Załączniki: dzienny breakdown oraz top usługi (CSV).</p>
  `;

  const dailyCsv = csvFromRows(summary.daily.map(d => ({
    date: d._id, orders: d.orders, paidOrders: d.paid, revenue_pln: Math.round((d.revenue || 0))/100
  })));

  const topCsv = csvFromRows(summary.topServices.map(t => ({
    service: String(t._id || ''), orders: t.count, paidOrders: t.paidCount, revenue_pln: Math.round((t.revenue||0))/100
  })));

  return await sendMail({
    to: list.join(','),
    subject: `Helpfli – Raport tygodniowy ${from.format('YYYY-MM-DD')} → ${to.format('YYYY-MM-DD')}`,
    html,
    attachments: [
      { filename: `weekly_daily_${from.format('YYYYMMDD')}_${to.format('YYYYMMDD')}.csv`, content: dailyCsv },
      { filename: `weekly_top_${from.format('YYYYMMDD')}_${to.format('YYYYMMDD')}.csv`, content: topCsv },
    ]
  });
}

function computeLastWeekRange(nowTz = dayjs().tz(TZ)) {
  const lastDay = nowTz.subtract(1, 'day');
  const lastMonday = lastDay.startOf('week').add(1, 'day');
  const from = lastMonday.startOf('day');
  const to = lastMonday.add(6, 'day').endOf('day');
  return { from, to };
}

function startWeeklyCron() {
  if (String(process.env.ENABLE_WEEKLY_REPORTS || 'false') !== 'true') return;

  const spec = process.env.REPORTS_CRON || '0 8 * * MON';
  const tzOpt = { timezone: TZ };

  cron.schedule(spec, async () => {
    try {
      const { from, to } = computeLastWeekRange(dayjs().tz(TZ));
      const summary = await buildWeeklySummary(from, to);

      await notifyAdminsPush({
        title: 'Helpfli – Raport tygodniowy',
        body: `Zlecenia: ${summary.ordersAll}, Obrót: ${(summary.revenue/100).toFixed(2)} PLN`,
        url: `${process.env.APP_URL || 'http://localhost:5173'}/admin/analytics`
      });

      await sendWeeklyEmail(from, to, summary);
    } catch (e) {
      console.error('Weekly report error:', e);
    }
  }, tzOpt);

  console.log('[cron] Weekly reports scheduled:', spec, 'TZ=', TZ);
}

module.exports = { startWeeklyCron };


