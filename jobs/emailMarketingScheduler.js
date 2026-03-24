const User = require('../models/User');
const Order = require('../models/Order');
const { sendWelcomeEmail2, sendWelcomeEmail3, sendAbandonedCartEmail, sendAbandonedCartSMS, sendReEngagementEmail } = require('./emailMarketing');

/**
 * Scheduler dla Email Marketing Automation
 * Uruchamiany codziennie o 9:00 (cron: '0 9 * * *')
 */
async function runEmailMarketingJobs() {
  try {
    console.log('📧 Starting email marketing jobs...');
    
    const now = new Date();
    const results = {
      welcome2: 0,
      welcome3: 0,
      abandonedCart: 0,
      reEngagement: 0,
      errors: 0
    };
    
    // Welcome Email 2 - 3 dni po rejestracji
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    threeDaysAgo.setHours(0, 0, 0, 0);
    
    const threeDaysAgoEnd = new Date(threeDaysAgo);
    threeDaysAgoEnd.setHours(23, 59, 59, 999);
    
    const usersForWelcome2 = await User.find({
      createdAt: {
        $gte: threeDaysAgo,
        $lte: threeDaysAgoEnd
      },
      emailVerified: true,
      'emailMarketing.welcome2Sent': { $ne: true }
    }).limit(100); // Limit na batch
    
    for (const user of usersForWelcome2) {
      try {
        await sendWelcomeEmail2(user);
        user.emailMarketing = user.emailMarketing || {};
        user.emailMarketing.welcome2Sent = true;
        user.emailMarketing.welcome2SentAt = new Date();
        await user.save();
        results.welcome2++;
      } catch (error) {
        console.error(`Error sending welcome email 2 to ${user.email}:`, error);
        results.errors++;
      }
    }
    
    // Welcome Email 3 - 7 dni po rejestracji
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    
    const sevenDaysAgoEnd = new Date(sevenDaysAgo);
    sevenDaysAgoEnd.setHours(23, 59, 59, 999);
    
    const usersForWelcome3 = await User.find({
      createdAt: {
        $gte: sevenDaysAgo,
        $lte: sevenDaysAgoEnd
      },
      emailVerified: true,
      'emailMarketing.welcome2Sent': true,
      'emailMarketing.welcome3Sent': { $ne: true }
    }).limit(100);
    
    for (const user of usersForWelcome3) {
      try {
        await sendWelcomeEmail3(user);
        user.emailMarketing = user.emailMarketing || {};
        user.emailMarketing.welcome3Sent = true;
        user.emailMarketing.welcome3SentAt = new Date();
        await user.save();
        results.welcome3++;
      } catch (error) {
        console.error(`Error sending welcome email 3 to ${user.email}:`, error);
        results.errors++;
      }
    }
    
    // Abandoned Cart - zlecenia w statusie "draft" starsze niż 36h
    // Również zlecenia "open" bez ofert starsze niż 48h
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    oneDayAgo.setHours(oneDayAgo.getHours() - 12); // 36h temu
    
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    
    // Zlecenia draft starsze niż 36h
    const abandonedDrafts = await Order.find({
      status: 'draft',
      createdAt: { $lt: oneDayAgo },
      'emailMarketing.abandonedCartSent': { $ne: true }
    })
      .populate('client')
      .limit(30);
    
    // Zlecenia open bez ofert starsze niż 48h
    const Offer = require('../models/Offer');
    const abandonedOpens = await Order.find({
      status: 'open',
      createdAt: { $lt: twoDaysAgo },
      'emailMarketing.abandonedCartSent': { $ne: true }
    })
      .populate('client')
      .limit(30);
    
    // Sprawdź które zlecenia open nie mają ofert
    const abandonedOpensWithoutOffers = [];
    for (const order of abandonedOpens) {
      const offerCount = await Offer.countDocuments({ orderId: order._id });
      if (offerCount === 0) {
        abandonedOpensWithoutOffers.push(order);
      }
    }
    
    const abandonedOrders = [...abandonedDrafts, ...abandonedOpensWithoutOffers];
    
    for (const order of abandonedOrders) {
      if (order.client && order.client.email) {
        try {
          // Wyślij email
          await sendAbandonedCartEmail(order.client, order._id);
          
          // Wyślij SMS (jeśli użytkownik ma numer telefonu)
          try {
            await sendAbandonedCartSMS(order.client, order._id);
          } catch (smsError) {
            console.error(`Error sending abandoned cart SMS for order ${order._id}:`, smsError);
            // Nie zwiększamy errors - SMS jest opcjonalny
          }
          
          order.emailMarketing = order.emailMarketing || {};
          order.emailMarketing.abandonedCartSent = true;
          order.emailMarketing.abandonedCartSentAt = new Date();
          await order.save();
          results.abandonedCart++;
        } catch (error) {
          console.error(`Error sending abandoned cart email for order ${order._id}:`, error);
          results.errors++;
        }
      }
    }
    
    // Re-engagement - nieaktywni użytkownicy
    // 7 dni nieaktywności
    const sevenDaysInactive = new Date(now);
    sevenDaysInactive.setDate(sevenDaysInactive.getDate() - 7);
    
    const users7Days = await User.find({
      'emailMarketing.lastActivity': { $lt: sevenDaysInactive },
      'emailMarketing.reEngagement7Sent': { $ne: true },
      emailVerified: true
    }).limit(50);
    
    for (const user of users7Days) {
      try {
        await sendReEngagementEmail(user, 7);
        user.emailMarketing = user.emailMarketing || {};
        user.emailMarketing.reEngagement7Sent = true;
        user.emailMarketing.reEngagement7SentAt = new Date();
        await user.save();
        results.reEngagement++;
      } catch (error) {
        console.error(`Error sending re-engagement email to ${user.email}:`, error);
        results.errors++;
      }
    }
    
    // 14 dni nieaktywności
    const fourteenDaysInactive = new Date(now);
    fourteenDaysInactive.setDate(fourteenDaysInactive.getDate() - 14);
    
    const users14Days = await User.find({
      'emailMarketing.lastActivity': { $lt: fourteenDaysInactive },
      'emailMarketing.reEngagement14Sent': { $ne: true },
      emailVerified: true
    }).limit(50);
    
    for (const user of users14Days) {
      try {
        await sendReEngagementEmail(user, 14);
        user.emailMarketing = user.emailMarketing || {};
        user.emailMarketing.reEngagement14Sent = true;
        user.emailMarketing.reEngagement14SentAt = new Date();
        await user.save();
        results.reEngagement++;
      } catch (error) {
        console.error(`Error sending re-engagement email to ${user.email}:`, error);
        results.errors++;
      }
    }
    
    // 30 dni nieaktywności
    const thirtyDaysInactive = new Date(now);
    thirtyDaysInactive.setDate(thirtyDaysInactive.getDate() - 30);
    
    const users30Days = await User.find({
      'emailMarketing.lastActivity': { $lt: thirtyDaysInactive },
      'emailMarketing.reEngagement30Sent': { $ne: true },
      emailVerified: true
    }).limit(50);
    
    for (const user of users30Days) {
      try {
        await sendReEngagementEmail(user, 30);
        user.emailMarketing = user.emailMarketing || {};
        user.emailMarketing.reEngagement30Sent = true;
        user.emailMarketing.reEngagement30SentAt = new Date();
        await user.save();
        results.reEngagement++;
      } catch (error) {
        console.error(`Error sending re-engagement email to ${user.email}:`, error);
        results.errors++;
      }
    }
    
    console.log(`✅ Email marketing jobs completed:`, results);
    return results;
  } catch (error) {
    console.error('❌ Email marketing jobs failed:', error);
    throw error;
  }
}

module.exports = { runEmailMarketingJobs };

