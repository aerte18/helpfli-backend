const cron = require('node-cron');
const User = require('../models/User');
const {
  isFoundingProviderActive,
  formatBenefitDate,
  expireFoundingProvider,
} = require('../utils/foundingProvider');
const NotificationService = require('../services/NotificationService');
const logger = require('../utils/logger');

const WARN_DAYS = [7, 3, 1, 0];
const REMINDER_FIELD = {
  7: 'expiryWarn7SentAt',
  3: 'expiryWarn3SentAt',
  1: 'expiryWarn1SentAt',
  0: 'expiryWarn0SentAt',
};

function daysLeft(until) {
  if (!until) return Infinity;
  const ms = new Date(until).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

async function sendExpiryWarning(user, days) {
  const expiresLabel = formatBenefitDate(user.foundingProviderExpiresAt);
  await NotificationService.sendNotification('founding_provider_expiring', [user._id], {
    providerName: user.name,
    daysLeft: days,
    expiresAtLabel: expiresLabel,
    linkPath: '/provider-home',
    metadata: { daysLeft: days, expiresAt: user.foundingProviderExpiresAt },
  });
}

async function sendExpiredNotice(user) {
  await NotificationService.sendNotification('founding_provider_expired', [user._id], {
    providerName: user.name,
    linkPath: '/subscriptions?audience=provider',
    metadata: { expiredAt: new Date() },
  });
}

async function runFoundingExpiryReminders() {
  const providers = await User.find({
    role: 'provider',
    foundingProvider: true,
    foundingProviderExpiresAt: { $gt: new Date() },
  }).select('name email foundingProviderExpiresAt foundingProviderReminders');

  for (const user of providers) {
    if (!isFoundingProviderActive(user)) continue;

    const left = daysLeft(user.foundingProviderExpiresAt);
    if (!WARN_DAYS.includes(left)) continue;

    const field = REMINDER_FIELD[left];
    if (!field) continue;
    if (!user.foundingProviderReminders) user.foundingProviderReminders = {};
    if (user.foundingProviderReminders[field]) continue;

    try {
      await sendExpiryWarning(user, left);
      user.foundingProviderReminders[field] = new Date();
      await user.save();
      logger.info(`[founding-cron] expiry warn ${left}d → ${user._id}`);
    } catch (e) {
      logger.error(`[founding-cron] expiry warn failed for ${user._id}:`, e?.message);
    }
  }
}

async function runFoundingExpiredNotifications() {
  const now = new Date();
  const expiredCandidates = await User.find({
    role: 'provider',
    foundingProvider: true,
    foundingProviderExpiresAt: { $lte: now },
  }).select('name email foundingProviderReminders foundingProviderExpiresAt badges');

  for (const user of expiredCandidates) {
    const { expired } = await expireFoundingProvider(user);
    if (!expired) continue;

    if (user.foundingProviderReminders?.expiredNotifiedAt) continue;

    try {
      await sendExpiredNotice(user);
      user.foundingProviderReminders = user.foundingProviderReminders || {};
      user.foundingProviderReminders.expiredNotifiedAt = new Date();
      await user.save();
      logger.info(`[founding-cron] expired notice → ${user._id}`);
    } catch (e) {
      logger.error(`[founding-cron] expired notice failed for ${user._id}:`, e?.message);
    }
  }
}

async function runOnce() {
  try {
    await runFoundingExpiryReminders();
    await runFoundingExpiredNotifications();
  } catch (e) {
    logger.error('[founding-cron] runOnce error:', e?.message || e);
  }
}

function startFoundingProviderGrowthCron() {
  if (String(process.env.ENABLE_FOUNDING_PROVIDER_CRON || 'true') !== 'true') {
    console.log('[cron] Founding provider growth cron disabled');
    return;
  }
  const spec = process.env.FOUNDING_PROVIDER_CRON || '10 9 * * *';
  cron.schedule(spec, () => runOnce().catch(console.error), { timezone: 'Europe/Warsaw' });
  console.log('[cron] Founding provider growth scheduled:', spec);
}

module.exports = { startFoundingProviderGrowthCron, runOnce };
