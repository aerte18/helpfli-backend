?const Order = require('../models/Order');
const User = require('../models/User');
const Rating = require('../models/Rating');
const { sendMail } = require('../utils/mailer');
const { sendPushToUser } = require('../utils/push');

/**
 * Job do wysyłania automatycznych prośb o recenzje
 * Uruchamiany codziennie o 10:00 (cron: '0 10 * * *')
 */
async function sendReviewReminders() {
  try {
    console.log('📧 Starting review reminder job...');
    
    // Znajdź zlecenia zakończone 24h temu, które nie mają jeszcze recenzji
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    const completedOrders = await Order.find({
      status: 'completed',
      completedAt: {
        $gte: yesterday,
        $lte: today
      }
    })
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .lean();
    
    console.log(`Found ${completedOrders.length} completed orders from yesterday`);
    
    let sentCount = 0;
    let errorCount = 0;
    
    for (const order of completedOrders) {
      try {
        // Sprawdź czy recenzja już istnieje
        const existingRating = await Rating.findOne({
          $or: [
            { from: order.client._id, to: order.provider._id, orderId: order._id },
            { from: order.provider._id, to: order.client._id, orderId: order._id }
          ]
        });
        
        if (existingRating) {
          console.log(`Order ${order._id} already has a rating, skipping`);
          continue;
        }
        
        // Sprawdź czy już wysłano reminder (można dodać pole `reviewReminderSent` do Order)
        if (order.reviewReminderSent) {
          continue;
        }
        
        // Wyślij email do klienta z prośbą o ocenę wykonawcy
        if (order.client && order.client.email) {
          const emailTemplate = {
            subject: 'Helpfli: Oceń wykonawcę i otrzymaj 10 punktów!',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #4F46E5;">Oceń wykonawcę i otrzymaj 10 punktów!</h2>
                <p>Cześć ${order.client.name || ''},</p>
                <p>Twoje zlecenie <strong>"${order.service || ''}"</strong> zostało zakończone.</p>
                <p>Pomóż innym użytkownikom i oceń wykonawcę <strong>${order.provider?.name || ''}</strong>.</p>
                <p><strong>Za każdą recenzję otrzymasz 10 punktów lojalnościowych!</strong></p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders/${order._id}?review=true" 
                     style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    Oceń wykonawcę
                  </a>
                </div>
                <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
              </div>
            `
          };
          
          try {
            await sendMail({
              to: order.client.email,
              subject: emailTemplate.subject,
              html: emailTemplate.html
            });
            console.log(`Review reminder email sent to ${order.client.email} for order ${order._id}`);
            sentCount++;
            
            // Oznacz że reminder został wysłany
            await Order.findByIdAndUpdate(order._id, { reviewReminderSent: true });
          } catch (emailError) {
            console.error(`Error sending email to ${order.client.email}:`, emailError);
            errorCount++;
          }
        }
        
        // Wyślij push notification
        try {
          await sendPushToUser(order.client._id, {
            title: 'Oceń wykonawcę',
            message: `Zlecenie "${order.service}" zakończone. Oceń wykonawcę i otrzymaj 10 punktów!`,
            url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders/${order._id}?review=true`
          });
        } catch (pushError) {
          console.error(`Error sending push to ${order.client._id}:`, pushError);
        }
        
      } catch (error) {
        console.error(`Error processing order ${order._id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`✅ Review reminder job completed: ${sentCount} sent, ${errorCount} errors`);
    return { sent: sentCount, errors: errorCount };
  } catch (error) {
    console.error('❌ Review reminder job failed:', error);
    throw error;
  }
}

module.exports = { sendReviewReminders };










