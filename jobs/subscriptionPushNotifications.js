const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const webpush = require('web-push');

/**
 * Push Notifications dla Subskrypcji
 * - Nowe funkcje PRO
 * - Trial reminders
 * - Retention campaigns
 */

// Push notification o nowych funkcjach PRO
async function sendNewFeaturesPushNotification(user, features) {
  try {
    if (!user.pushSubs || user.pushSubs.length === 0) return { success: false, reason: 'no_subscriptions' };
    
    const message = {
      title: '🎉 Nowe funkcje w PRO!',
      body: `Sprawdź nowe funkcje: ${features.join(', ')}`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: {
        url: '/account/subscriptions',
        type: 'new_features'
      }
    };
    
    let sentCount = 0;
    for (const sub of user.pushSubs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(message));
        sentCount++;
      } catch (error) {
        // Jeśli subskrypcja jest niepoprawna, usuń ją
        if (error.statusCode === 410 || error.statusCode === 404) {
          await User.updateOne(
            { _id: user._id },
            { $pull: { pushSubs: { endpoint: sub.endpoint } } }
          );
        }
      }
    }
    
    return { success: true, sentCount };
  } catch (error) {
    console.error('Error sending new features push notification:', error);
    return { success: false, error: error.message };
  }
}

// Push notification - trial reminder
async function sendTrialReminderPush(user, subscription) {
  try {
    if (!user.pushSubs || user.pushSubs.length === 0) return { success: false, reason: 'no_subscriptions' };
    
    const daysLeft = Math.ceil((subscription.trialEndsAt - new Date()) / (1000 * 60 * 60 * 24));
    const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
    
    const message = {
      title: `⏰ Trial PRO kończy się za ${daysLeft} dni!`,
      body: `Nie przegap korzyści z ${plan?.name || 'PRO'}. Oszczędzaj ${15 - (plan?.platformFeePercent || 5)}% na platform fee!`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: {
        url: '/account/subscriptions',
        type: 'trial_reminder'
      }
    };
    
    let sentCount = 0;
    for (const sub of user.pushSubs) {
      try {
        await sendPushNotification(sub, message);
        sentCount++;
      } catch (error) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          await User.updateOne(
            { _id: user._id },
            { $pull: { pushSubs: { endpoint: sub.endpoint } } }
          );
        }
      }
    }
    
    return { success: true, sentCount };
  } catch (error) {
    console.error('Error sending trial reminder push:', error);
    return { success: false, error: error.message };
  }
}

// Push notification - retention (dla użytkowników którzy anulowali)
async function sendRetentionPush(user, subscription) {
  try {
    if (!user.pushSubs || user.pushSubs.length === 0) return { success: false, reason: 'no_subscriptions' };
    
    const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
    const daysUntilExpiry = Math.ceil((subscription.validUntil - new Date()) / (1000 * 60 * 60 * 24));
    
    const message = {
      title: '💔 Twoja subskrypcja PRO wygasa!',
      body: `Zostało ${daysUntilExpiry} dni. Przywróć subskrypcję i oszczędzaj ${15 - (plan?.platformFeePercent || 5)}% na platform fee!`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: {
        url: '/account/subscriptions',
        type: 'retention'
      }
    };
    
    let sentCount = 0;
    for (const sub of user.pushSubs) {
      try {
        await sendPushNotification(sub, message);
        sentCount++;
      } catch (error) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          await User.updateOne(
            { _id: user._id },
            { $pull: { pushSubs: { endpoint: sub.endpoint } } }
          );
        }
      }
    }
    
    return { success: true, sentCount };
  } catch (error) {
    console.error('Error sending retention push:', error);
    return { success: false, error: error.message };
  }
}

// Cron job do wysyłania push notifications
async function runSubscriptionPushNotifications() {
  try {
    const now = new Date();
    
    // 1. Trial reminders - 1 dzień przed końcem
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const trialsEndingTomorrow = await UserSubscription.find({
      isTrial: true,
      trialEndsAt: {
        $gte: now,
        $lte: tomorrow
      }
    }).populate('user');
    
    for (const sub of trialsEndingTomorrow) {
      if (sub.user && sub.user.pushSubs && sub.user.pushSubs.length > 0) {
        await sendTrialReminderPush(sub.user, sub);
      }
    }
    
    // 2. Retention - użytkownicy którzy anulowali (3 dni przed wygaśnięciem)
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const expiringSubscriptions = await UserSubscription.find({
      renews: false,
      validUntil: {
        $gte: new Date(threeDaysFromNow.getTime() - 24 * 60 * 60 * 1000),
        $lte: threeDaysFromNow
      },
      isTrial: false
    }).populate('user');
    
    for (const sub of expiringSubscriptions) {
      if (sub.user && sub.user.pushSubs && sub.user.pushSubs.length > 0) {
        await sendRetentionPush(sub.user, sub);
      }
    }
    
    console.log(`Subscription push notifications: Sent ${trialsEndingTomorrow.length} trial reminders, ${expiringSubscriptions.length} retention pushes`);
    
    return { success: true };
  } catch (error) {
    console.error('Error running subscription push notifications:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendNewFeaturesPushNotification,
  sendTrialReminderPush,
  sendRetentionPush,
  runSubscriptionPushNotifications
};
