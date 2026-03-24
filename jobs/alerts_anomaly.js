const cron = require('node-cron');
const dayjs = require('dayjs');
const Order = require('../models/Order');
const User = require('../models/User');
const Settings = require('../models/Settings');
const PushSubscription = require('../models/pushSubscription');
const webpush = require('web-push');
const { sendMail } = require('../utils/email');

const TZ = process.env.REPORTS_TZ || 'Europe/Warsaw';

// Tymczasowo wyłączone - wymaga prawidłowych kluczy VAPID
// webpush.setVapidDetails(
//   process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
//   process.env.VAPID_PUBLIC_KEY,
//   process.env.VAPID_PRIVATE_KEY
// );

async function notifyAdmins({ title, body, url }) {
  const admins = await User.find({ role: 'admin' }).select('_id').lean();
  const subs = await PushSubscription.find({ user: { $in: admins.map(a => a._id) } });
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body, url })); }
    catch (e) { if (e.statusCode===410||e.statusCode===404) await PushSubscription.deleteOne({ _id: s._id }); }
  }
  const recipients = (process.env.ADMIN_REPORT_EMAILS || '').trim();
  if (recipients) {
    await sendMail({ to: recipients, subject: title, html: `<p>${body}</p><p><a href="${url||'#'}">Panel Analytics</a></p>` });
  }
}

function iso(d) { return dayjs(d).format('YYYY-MM-DD'); }

async function computeWeekRange(offsetWeeks = 0) {
  const now = dayjs();
  const end = now.subtract(offsetWeeks, 'week').startOf('week').add(6, 'day').endOf('day');
  const start = end.startOf('week').add(1, 'day').startOf('day');
  return { start: start.toDate(), end: end.toDate(), label: `${iso(start)} → ${iso(end)}` };
}

async function getPaidShare({ start, end }) {
  const orders = await Order.countDocuments({ createdAt: { $gte: start, $lte: end } });
  const paid = await Order.countDocuments({ createdAt: { $gte: start, $lte: end }, paidInSystem: true, paymentStatus: 'succeeded' });
  const share = orders ? (paid / orders) : 0;
  return { orders, paid, share };
}

async function getThresholds() {
  const doc = await Settings.findOne({ key: 'anomalyThresholds' }).lean();
  const v = doc?.value || {};
  return {
    minOrders: Number.isFinite(v.minOrders) ? v.minOrders : 30,
    absDropPp: Number.isFinite(v.absDropPp) ? v.absDropPp : 10,
    relDropPct: Number.isFinite(v.relDropPct) ? v.relDropPct : 20,
  };
}

function isAnomalousDrop(prevShare, currShare, prevOrders, currOrders, thr) {
  if (currOrders < (thr.minOrders || 30)) return false;
  const absDrop = (prevShare - currShare) * 100;
  const relDrop = prevShare ? (absDrop / (prevShare*100)) * 100 : 0;
  return absDrop >= (thr.absDropPp || 10) || relDrop >= (thr.relDropPct || 20);
}

function startAnomalyAlerts() {
  if (String(process.env.ENABLE_ANOMALY_ALERTS || 'false') !== 'true') return;

  const spec = process.env.ANOMALY_CRON || '30 8 * * *';
  cron.schedule(spec, async () => {
    try {
      const last = await computeWeekRange(0);
      const prev = await computeWeekRange(1);

      const [curr, before, thr] = await Promise.all([
        getPaidShare(last),
        getPaidShare(prev),
        getThresholds(),
      ]);

      if (isAnomalousDrop(before.share, curr.share, before.orders, curr.orders, thr)) {
        const title = '⚠️ Spadek udziału płatności w systemie (tydz/tydz)';
        const body  = `Poprzednio: ${(before.share*100).toFixed(1)}% z ${before.orders}; Teraz: ${(curr.share*100).toFixed(1)}% z ${curr.orders}.\nProgi: minOrders=${thr.minOrders}, absDrop≥${thr.absDropPp}pp lub relDrop≥${thr.relDropPct}%.`;
        await notifyAdmins({ title, body, url: `${process.env.APP_URL}/admin/analytics` });
      }
    } catch (e) {
      console.error('[anomaly] error', e);
    }
  }, { timezone: TZ });

  console.log('[cron] Anomaly alerts scheduled:', spec);
}

module.exports = { startAnomalyAlerts };
