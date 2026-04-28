const UserSubscription = require('../models/UserSubscription');
const User = require('../models/User');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const { sendMail } = require('../utils/mailer');
const { sendPushToUser } = require('../utils/push');
const smsService = require('../services/smsService');
const NotificationLog = require('../models/NotificationLog');
const Notification = require('../models/Notification');

async function createInAppSubscriptionNotification({
  userId,
  type = 'subscription_expiring',
  title,
  message,
  daysLeft = null,
  subscriptionId = null,
  planKey = null
}) {
  try {
    await Notification.create({
      user: userId,
      type,
      title,
      message,
      link: '/account/subscriptions',
      metadata: {
        ...(daysLeft !== null ? { daysLeft } : {}),
        ...(subscriptionId ? { subscriptionId: String(subscriptionId) } : {}),
        ...(planKey ? { planKey } : {})
      }
    });
  } catch (error) {
    console.error('Error creating in-app subscription notification:', error);
  }
}

/**
 * Job do wysyłania powiadomień o wygasaniu subskrypcji
 * Uruchamiany codziennie o 8:00
 */
async function sendSubscriptionExpiryNotifications() {
  try {
    console.log('📧 Starting subscription expiry notifications...');
    
    const now = new Date();
    const results = {
      sent7days: 0,
      sent3days: 0,
      sent1day: 0,
      sentExpired: 0,
      errors: 0
    };

    // 7 dni przed wygaśnięciem
    const sevenDaysFromNow = new Date(now);
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    sevenDaysFromNow.setHours(0, 0, 0, 0);
    const sevenDaysEnd = new Date(sevenDaysFromNow);
    sevenDaysEnd.setHours(23, 59, 59, 999);

    const subs7days = await UserSubscription.find({
      validUntil: { $gte: sevenDaysFromNow, $lte: sevenDaysEnd },
      renews: true,
      'notifications.expiry7daysSent': { $ne: true }
    }).populate('user', 'name email');

    for (const sub of subs7days) {
      try {
        const plan = await SubscriptionPlan.findOne({ key: sub.planKey });
        const user = await User.findById(sub.user._id || sub.user);
        const prefs = user?.notificationPreferences?.subscriptionExpiry || {};
        
        // Email
        if (prefs.email !== false && prefs.daysBefore?.includes(7)) {
          await sendSubscriptionExpiryEmail(user, sub, plan, 7);
        }
        
        // SMS
        if (prefs.sms && user?.phone && prefs.daysBefore?.includes(7)) {
          const expiryDate = new Date(sub.validUntil).toLocaleDateString('pl-PL');
          if (!process.env.FRONTEND_URL) {
            console.error('⚠️ FRONTEND_URL not set, skipping SMS notification');
            return;
          }
          const message = `Helpfli: Twoja subskrypcja ${plan?.name || sub.planKey} wygasa za 7 dni (${expiryDate}). Odnów: ${process.env.FRONTEND_URL}/account/subscriptions?renew=true`;
          await smsService.sendSMS(user.phone, message, {
            userId: user._id,
            type: 'subscription_expiry_7days',
            metadata: { subscriptionId: sub._id, planKey: sub.planKey }
          });
        }
        
        // Push (jeśli włączone)
        if (prefs.push !== false) {
          try {
            await sendPushToUser(user._id, {
              title: 'Subskrypcja wygasa za 7 dni',
              message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasa za 7 dni. Odnów teraz!`,
              url: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/account/subscriptions?renew=true` : undefined
            });
          } catch (pushError) {
            console.error(`Push notification error:`, pushError);
          }
        }
        await createInAppSubscriptionNotification({
          userId: user._id,
          type: 'subscription_expiring',
          title: 'Subskrypcja wygasa za 7 dni',
          message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasa za 7 dni. Odnów teraz!`,
          daysLeft: 7,
          subscriptionId: sub._id,
          planKey: sub.planKey
        });
        
        sub.notifications = sub.notifications || {};
        sub.notifications.expiry7daysSent = true;
        sub.notifications.expiry7daysSentAt = new Date();
        await sub.save();
        
        results.sent7days++;
      } catch (error) {
        console.error(`Error sending 7-day expiry notification to ${sub.user?.email}:`, error);
        results.errors++;
      }
    }

    // 3 dni przed wygaśnięciem
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    threeDaysFromNow.setHours(0, 0, 0, 0);
    const threeDaysEnd = new Date(threeDaysFromNow);
    threeDaysEnd.setHours(23, 59, 59, 999);

    const subs3days = await UserSubscription.find({
      validUntil: { $gte: threeDaysFromNow, $lte: threeDaysEnd },
      renews: true,
      'notifications.expiry3daysSent': { $ne: true }
    }).populate('user', 'name email');

    for (const sub of subs3days) {
      try {
        const plan = await SubscriptionPlan.findOne({ key: sub.planKey });
        const user = await User.findById(sub.user._id || sub.user);
        const prefs = user?.notificationPreferences?.subscriptionExpiry || {};
        
        // Email
        if (prefs.email !== false && prefs.daysBefore?.includes(3)) {
          await sendSubscriptionExpiryEmail(user, sub, plan, 3);
        }
        
        // SMS
        if (prefs.sms && user?.phone && prefs.daysBefore?.includes(3)) {
          const expiryDate = new Date(sub.validUntil).toLocaleDateString('pl-PL');
          if (!process.env.FRONTEND_URL) {
            console.error('⚠️ FRONTEND_URL not set, skipping SMS notification');
            return;
          }
          const message = `Helpfli: Twoja subskrypcja ${plan?.name || sub.planKey} wygasa za 3 dni (${expiryDate}). Odnów: ${process.env.FRONTEND_URL}/account/subscriptions?renew=true`;
          await smsService.sendSMS(user.phone, message, {
            userId: user._id,
            type: 'subscription_expiry_3days',
            metadata: { subscriptionId: sub._id, planKey: sub.planKey }
          });
        }
        
        // Push
        if (prefs.push !== false) {
          try {
            await sendPushToUser(user._id, {
              title: 'Subskrypcja wygasa za 3 dni',
              message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasa za 3 dni. Odnów teraz!`,
              url: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/account/subscriptions?renew=true` : undefined
            });
          } catch (pushError) {
            console.error(`Push notification error:`, pushError);
          }
        }
        await createInAppSubscriptionNotification({
          userId: user._id,
          type: 'subscription_expiring',
          title: 'Subskrypcja wygasa za 3 dni',
          message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasa za 3 dni. Odnów teraz!`,
          daysLeft: 3,
          subscriptionId: sub._id,
          planKey: sub.planKey
        });
        
        sub.notifications = sub.notifications || {};
        sub.notifications.expiry3daysSent = true;
        sub.notifications.expiry3daysSentAt = new Date();
        await sub.save();
        
        results.sent3days++;
      } catch (error) {
        console.error(`Error sending 3-day expiry notification to ${sub.user?.email}:`, error);
        results.errors++;
      }
    }

    // 1 dzień przed wygaśnięciem
    const oneDayFromNow = new Date(now);
    oneDayFromNow.setDate(oneDayFromNow.getDate() + 1);
    oneDayFromNow.setHours(0, 0, 0, 0);
    const oneDayEnd = new Date(oneDayFromNow);
    oneDayEnd.setHours(23, 59, 59, 999);

    const subs1day = await UserSubscription.find({
      validUntil: { $gte: oneDayFromNow, $lte: oneDayEnd },
      renews: true,
      'notifications.expiry1daySent': { $ne: true }
    }).populate('user', 'name email');

    for (const sub of subs1day) {
      try {
        const plan = await SubscriptionPlan.findOne({ key: sub.planKey });
        const user = await User.findById(sub.user._id || sub.user);
        const prefs = user?.notificationPreferences?.subscriptionExpiry || {};
        
        // Email
        if (prefs.email !== false && prefs.daysBefore?.includes(1)) {
          await sendSubscriptionExpiryEmail(user, sub, plan, 1);
        }
        
        // SMS (zawsze wysyłamy 1 dzień przed, nawet jeśli nie ma w daysBefore)
        if (prefs.sms && user?.phone) {
          const expiryDate = new Date(sub.validUntil).toLocaleDateString('pl-PL');
          if (!process.env.FRONTEND_URL) {
            console.error('⚠️ FRONTEND_URL not set, skipping SMS notification');
            return;
          }
          const message = `Helpfli: ⚠️ Twoja subskrypcja ${plan?.name || sub.planKey} wygasa JUTRO (${expiryDate})! Odnów teraz: ${process.env.FRONTEND_URL}/account/subscriptions?renew=true`;
          await smsService.sendSMS(user.phone, message, {
            userId: user._id,
            type: 'subscription_expiry_1day',
            metadata: { subscriptionId: sub._id, planKey: sub.planKey }
          });
        }
        
        // Push notification
        if (prefs.push !== false) {
          try {
            await sendPushToUser(user._id, {
              title: 'Subskrypcja wygasa jutro!',
              message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasa jutro. Odnów teraz!`,
              url: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/account/subscriptions?renew=true` : undefined
            });
          } catch (pushError) {
            console.error(`Push notification error:`, pushError);
          }
        }
        await createInAppSubscriptionNotification({
          userId: user._id,
          type: 'subscription_expiring',
          title: 'Subskrypcja wygasa jutro',
          message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasa jutro. Odnów teraz!`,
          daysLeft: 1,
          subscriptionId: sub._id,
          planKey: sub.planKey
        });
        
        sub.notifications = sub.notifications || {};
        sub.notifications.expiry1daySent = true;
        sub.notifications.expiry1daySentAt = new Date();
        await sub.save();
        
        results.sent1day++;
      } catch (error) {
        console.error(`Error sending 1-day expiry notification to ${sub.user?.email}:`, error);
        results.errors++;
      }
    }

    // Wygasłe subskrypcje (grace period)
    const expiredDate = new Date(now);
    expiredDate.setDate(expiredDate.getDate() - 1); // Wczoraj wygasły
    expiredDate.setHours(0, 0, 0, 0);
    const expiredEnd = new Date(expiredDate);
    expiredEnd.setHours(23, 59, 59, 999);

    const expiredSubs = await UserSubscription.find({
      validUntil: { $gte: expiredDate, $lte: expiredEnd },
      'notifications.expiredSent': { $ne: true }
    }).populate('user', 'name email');

    for (const sub of expiredSubs) {
      try {
        const plan = await SubscriptionPlan.findOne({ key: sub.planKey });
        const user = await User.findById(sub.user._id || sub.user);
        const prefs = user?.notificationPreferences?.subscriptionExpiry || {};
        
        // Email
        if (prefs.email !== false) {
          await sendSubscriptionExpiredEmail(user, sub, plan);
        }
        
        // SMS
        if (prefs.sms && user?.phone) {
          if (!process.env.FRONTEND_URL) {
            console.error('⚠️ FRONTEND_URL not set, skipping SMS notification');
            return;
          }
          const message = `Helpfli: ⚠️ Twoja subskrypcja ${plan?.name || sub.planKey} wygasła! Masz 7 dni na przywrócenie z 20% zniżką: ${process.env.FRONTEND_URL}/account/subscriptions?restore=true&discount=20`;
          await smsService.sendSMS(user.phone, message, {
            userId: user._id,
            type: 'subscription_expired',
            metadata: { subscriptionId: sub._id, planKey: sub.planKey }
          });
        }
        
        // Push
        if (prefs.push !== false) {
          try {
            await sendPushToUser(user._id, {
              title: 'Subskrypcja wygasła',
              message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasła. Przywróć z 20% zniżką!`,
              url: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/account/subscriptions?restore=true&discount=20` : undefined
            });
          } catch (pushError) {
            console.error(`Push notification error:`, pushError);
          }
        }
        await createInAppSubscriptionNotification({
          userId: user._id,
          type: 'subscription_expired',
          title: 'Subskrypcja wygasła',
          message: `Twoja subskrypcja ${plan?.name || sub.planKey} wygasła. Przywróć z 20% zniżką!`,
          subscriptionId: sub._id,
          planKey: sub.planKey
        });
        
        sub.notifications = sub.notifications || {};
        sub.notifications.expiredSent = true;
        sub.notifications.expiredSentAt = new Date();
        await sub.save();
        
        results.sentExpired++;
      } catch (error) {
        console.error(`Error sending expired notification to ${sub.user?.email}:`, error);
        results.errors++;
      }
    }

    console.log(`✅ Subscription expiry notifications completed:`, results);
    return results;
  } catch (error) {
    console.error('❌ Subscription expiry notifications job failed:', error);
    throw error;
  }
}

async function sendSubscriptionExpiryEmail(user, subscription, plan, daysLeft) {
  if (!process.env.FRONTEND_URL) {
    console.error('⚠️ FRONTEND_URL not set, cannot send subscription expiry email');
    return;
  }
  const frontendUrl = process.env.FRONTEND_URL;
  const expiryDate = new Date(subscription.validUntil).toLocaleDateString('pl-PL');
  
  // Sprawdź czy istnieje szablon emaila
  const EmailTemplate = require('../models/EmailTemplate');
  let template = await EmailTemplate.findOne({ 
    key: `subscription_expiry_${daysLeft}days`,
    isActive: true 
  });
  
  let subject, htmlBody;
  
  if (template) {
    // Użyj szablonu
    const rendered = template.render({
      userName: user.name || '',
      planName: plan?.name || subscription.planKey,
      expiryDate: expiryDate,
      daysLeft: daysLeft.toString(),
      renewUrl: `${frontendUrl}/account/subscriptions?renew=true`,
      loyaltyMonths: subscription.loyaltyMonths?.toString() || '0',
      loyaltyDiscount: subscription.loyaltyDiscount?.toString() || '0'
    });
    subject = rendered.subject;
    htmlBody = rendered.htmlBody;
  } else {
    // Domyślny szablon
    subject = `⏰ Twoja subskrypcja ${plan?.name || subscription.planKey} wygasa za ${daysLeft} ${daysLeft === 1 ? 'dzień' : 'dni'}`;
    htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">⏰ Subskrypcja wygasa za ${daysLeft} ${daysLeft === 1 ? 'dzień' : 'dni'}</h1>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <p>Cześć ${user.name || ''},</p>
          <p>Twoja subskrypcja <strong>${plan?.name || subscription.planKey}</strong> wygasa <strong>${expiryDate}</strong>.</p>
          
          ${daysLeft === 1 ? `
            <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #fa709a;">
              <p style="margin: 0; color: #fa709a; font-weight: bold;">⚠️ To ostatni dzień! Odnów teraz, aby nie stracić dostępu do funkcji PRO.</p>
            </div>
          ` : ''}
          
          <h2 style="color: #667eea; margin-top: 30px;">Co stracisz po wygaśnięciu:</h2>
          <ul style="line-height: 1.8;">
            ${plan?.perks?.map(perk => `<li>❌ ${perk}</li>`).join('') || ''}
          </ul>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}/account/subscriptions?renew=true" 
               style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
              Odnów subskrypcję teraz
            </a>
          </div>
          
          ${subscription.loyaltyMonths >= 6 ? `
            <div style="background: #f0f9ff; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6;">
              <p style="margin: 0; color: #1e40af;">
                💎 Jesteś z nami już ${subscription.loyaltyMonths} miesięcy! Otrzymujesz ${subscription.loyaltyDiscount}% zniżki lojalnościowej.
              </p>
            </div>
          ` : ''}
          
          <p style="color: #666; font-size: 14px; margin-top: 30px;">
            Pozdrawiamy,<br/>
            <strong>Zespół Helpfli</strong>
          </p>
        </div>
      </div>
    `;
  }
  
  // Loguj wysłanie emaila
  try {
    await NotificationLog.create({
      user: user._id,
      type: `subscription_expiry_${daysLeft}days`,
      channel: 'email',
      status: 'sent',
      subject,
      message: htmlBody,
      recipient: user.email,
      templateId: template?._id,
      metadata: { subscriptionId: subscription._id, planKey: subscription.planKey, daysLeft },
      sentAt: new Date()
    });
  } catch (logError) {
    console.error('Error logging notification:', logError);
  }
  
  await sendMail({
    to: user.email,
    subject,
    html: htmlBody
  });
}

async function sendSubscriptionExpiredEmail(user, subscription, plan) {
  if (!process.env.FRONTEND_URL) {
    console.error('⚠️ FRONTEND_URL not set, cannot send subscription expiry email');
    return;
  }
  const frontendUrl = process.env.FRONTEND_URL;
  
  // Sprawdź czy istnieje szablon emaila
  const EmailTemplate = require('../models/EmailTemplate');
  let template = await EmailTemplate.findOne({ 
    key: 'subscription_expired',
    isActive: true 
  });
  
  let subject, htmlBody;
  
  if (template) {
    // Użyj szablonu
    const rendered = template.render({
      userName: user.name || '',
      planName: plan?.name || subscription.planKey,
      restoreUrl: `${frontendUrl}/account/subscriptions?restore=true&discount=20`
    });
    subject = rendered.subject;
    htmlBody = rendered.htmlBody;
  } else {
    // Domyślny szablon
    subject = '⚠️ Twoja subskrypcja wygasła - masz 7 dni na przywrócenie';
    htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">⚠️ Subskrypcja wygasła</h1>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <p>Cześć ${user.name || ''},</p>
          <p>Twoja subskrypcja <strong>${plan?.name || subscription.planKey}</strong> wygasła.</p>
          
          <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #fa709a;">
            <p style="margin: 0; color: #fa709a; font-weight: bold;">
              ⏰ Masz 7 dni grace period - możesz przywrócić subskrypcję bez utraty danych!
            </p>
          </div>
          
          <h2 style="color: #667eea; margin-top: 30px;">Specjalna oferta powrotu:</h2>
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid #22c55e;">
            <p style="margin: 0; font-size: 18px; font-weight: bold; color: #15803d;">
              🎁 Otrzymujesz 20% zniżki na pierwszy miesiąc!
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}/account/subscriptions?restore=true&discount=20" 
               style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
              Przywróć subskrypcję z 20% zniżką
            </a>
          </div>
          
          <p style="color: #666; font-size: 14px; margin-top: 30px;">
            Po 7 dniach zostaniesz automatycznie przeniesiony na plan FREE.<br/>
            Pozdrawiamy,<br/>
            <strong>Zespół Helpfli</strong>
          </p>
        </div>
      </div>
    `;
  }
  
  // Loguj wysłanie emaila
  try {
    await NotificationLog.create({
      user: user._id,
      type: 'subscription_expired',
      channel: 'email',
      status: 'sent',
      subject,
      message: htmlBody,
      recipient: user.email,
      templateId: template?._id,
      metadata: { subscriptionId: subscription._id, planKey: subscription.planKey },
      sentAt: new Date()
    });
  } catch (logError) {
    console.error('Error logging notification:', logError);
  }
  
  await sendMail({
    to: user.email,
    subject,
    html: htmlBody
  });
}

module.exports = { sendSubscriptionExpiryNotifications };







