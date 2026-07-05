const User = require('../models/User');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/pushSubscription');
const webpush = require('web-push');
const { sendMail } = require('../utils/mailer');
const { getFrontendUrl } = require('./publicUrl');

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@helpfli.app',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      vapidReady = true;
    } catch {
      /* ignore */
    }
  }
}

/**
 * Powiadom administratorów (push + email + opcjonalnie in-app).
 * @param {{ title: string, body: string, url?: string, type?: string, meta?: object }} payload
 */
async function notifyAdmins(payload) {
  const { title, body, url, type = 'admin_alert', meta = {} } = payload;
  if (!title || !body) return;

  const link = url || `${getFrontendUrl()}/admin/disputes`;
  const admins = await User.find({
    role: { $in: ['admin', 'superadmin'] },
    isActive: { $ne: false },
  })
    .select('_id email')
    .lean();

  if (!admins.length) return;

  ensureVapid();
  const adminIds = admins.map((a) => a._id);
  const subs = await PushSubscription.find({ user: { $in: adminIds } });
  const pushPayload = JSON.stringify({ title, body, url: link });

  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, pushPayload);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await PushSubscription.deleteOne({ _id: s._id });
      }
    }
  }

  const recipients =
    process.env.ADMIN_REPORT_EMAILS ||
    process.env.ADMIN_ALERT_EMAILS ||
    admins.map((a) => a.email).filter(Boolean).join(',');
  if (recipients) {
    try {
      await sendMail({
        to: recipients,
        subject: `[Helpfli Admin] ${title}`,
        html: `<p>${body}</p><p><a href="${link}">Otwórz panel</a></p>`,
      });
    } catch (e) {
      console.warn('ADMIN_NOTIFY_EMAIL_FAIL:', e.message);
    }
  }

  await Promise.all(
    adminIds.map((userId) =>
      Notification.create({
        user: userId,
        type,
        title,
        message: body,
        link: link.replace(getFrontendUrl(), '') || '/admin/disputes',
        read: false,
        metadata: meta,
      }).catch(() => null)
    )
  );
}

module.exports = { notifyAdmins };
