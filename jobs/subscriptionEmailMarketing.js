?const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const { sendMail } = require('../utils/email');

/**
 * Email Marketing dla Subskrypcji
 * - Trial reminders (3 dni przed końcem)
 * - Trial conversion (ostatni dzień)
 * - Retention campaigns (dla użytkowników na granicy anulowania)
 * - Promocje dla nieaktywnych użytkowników
 */

// Trial Reminder - 3 dni przed końcem
async function sendTrialReminderEmail(user, subscription) {
  try {
    const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
    const daysLeft = Math.ceil((subscription.trialEndsAt - new Date()) / (1000 * 60 * 60 * 24));
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    await sendMail({
      to: user.email,
      subject: `🎁 Twój trial PRO kończy się za ${daysLeft} dni!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Twój trial PRO kończy się za ${daysLeft} dni!</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>Twój 7-dniowy trial planu <strong>${plan?.name || subscription.planKey}</strong> kończy się za ${daysLeft} dni.</p>
            
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <h3 style="margin: 0 0 10px 0; color: #92400e;">Co stracisz po zakończeniu trialu:</h3>
              <ul style="margin: 0; padding-left: 20px; color: #78350f;">
                <li>Nielimitowane odpowiedzi/zapytania</li>
                <li>Niższe platform fee (${plan?.platformFeePercent ?? 0}% zamiast 15%)</li>
                <li>Priorytet w wynikach wyszukiwania</li>
                <li>Zaawansowane statystyki</li>
              </ul>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}/account/subscriptions" 
                 style="background: #f97316; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">
                Przedłuż subskrypcję →
              </a>
            </div>
            
            <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
              Anuluj w każdej chwili. Bez zobowiązań.
            </p>
          </div>
        </div>
      `
    });
    
    return { success: true };
  } catch (error) {
    console.error('Error sending trial reminder email:', error);
    return { success: false, error: error.message };
  }
}

// Trial Conversion - ostatni dzień
async function sendTrialConversionEmail(user, subscription) {
  try {
    const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    await sendMail({
      to: user.email,
      subject: '⏰ Ostatni dzień trialu PRO - nie przegap!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">⏰ Ostatni dzień trialu!</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p style="font-size: 18px; font-weight: bold; color: #dc2626;">
              Twój trial PRO kończy się DZIŚ!
            </p>
            
            <p>Nie przegap korzyści z planu PRO:</p>
            <ul style="line-height: 2;">
              <li>💰 <strong>Oszczędzaj ${15 - (plan?.platformFeePercent || 5)}%</strong> na platform fee przy każdym zleceniu</li>
              <li>🚀 <strong>Nielimitowane</strong> odpowiedzi i zapytania AI</li>
              <li>⭐ <strong>Priorytet</strong> w wynikach wyszukiwania</li>
              <li>📊 <strong>Zaawansowane statystyki</strong> i analityka</li>
            </ul>
            
            <div style="background: #fef2f2; border: 2px solid #dc2626; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: center;">
              <p style="margin: 0; font-size: 24px; font-weight: bold; color: #dc2626;">
                Tylko ${plan?.priceMonthly || 99} zł/mies.
              </p>
              <p style="margin: 5px 0 0 0; color: #6b7280; font-size: 14px;">
                Oszczędzaj ${(15 - (plan?.platformFeePercent ?? 0)) * 10} zł przy każdym zleceniu za 1000 zł
              </p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}/account/subscriptions" 
                 style="background: #dc2626; color: white; padding: 16px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 18px;">
                Przedłuż teraz →
              </a>
            </div>
          </div>
        </div>
      `
    });
    
    return { success: true };
  } catch (error) {
    console.error('Error sending trial conversion email:', error);
    return { success: false, error: error.message };
  }
}

// Retention Campaign - dla użytkowników którzy anulowali auto-odnowienie
async function sendRetentionEmail(user, subscription) {
  try {
    const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const daysUntilExpiry = Math.ceil((subscription.validUntil - new Date()) / (1000 * 60 * 60 * 24));
    
    await sendMail({
      to: user.email,
      subject: `💔 Twoja subskrypcja PRO wygasa za ${daysUntilExpiry} dni`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Nie odchodź! 😢</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>Widzimy, że anulowałeś auto-odnowienie subskrypcji PRO. Twoja subskrypcja wygasa za ${daysUntilExpiry} dni.</p>
            
            <div style="background: #f3f4f6; padding: 20px; margin: 20px 0; border-radius: 8px;">
              <h3 style="margin: 0 0 15px 0;">Czy wiesz, że z PRO:</h3>
              <ul style="margin: 0; padding-left: 20px; line-height: 2;">
                <li>Oszczędzasz <strong>${(15 - (plan?.platformFeePercent || 5)) * 10} zł</strong> przy każdym zleceniu za 1000 zł</li>
                <li>Masz <strong>nielimitowane</strong> odpowiedzi i zapytania</li>
                <li>Jesteś <strong>wyżej</strong> w wynikach wyszukiwania</li>
                <li>Masz dostęp do <strong>zaawansowanych statystyk</strong></li>
              </ul>
            </div>
            
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; font-weight: bold; color: #92400e;">
                🎁 Specjalna oferta: Przedłuż teraz i otrzymaj 10% zniżki na pierwszy miesiąc!
              </p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}/account/subscriptions" 
                 style="background: #7c3aed; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">
                Przywróć subskrypcję →
              </a>
            </div>
            
            <p style="color: #6b7280; font-size: 14px; margin-top: 20px; text-align: center;">
              Jeśli masz pytania, skontaktuj się z nami: <a href="mailto:support@helpfli.pl">support@helpfli.pl</a>
            </p>
          </div>
        </div>
      `
    });
    
    return { success: true };
  } catch (error) {
    console.error('Error sending retention email:', error);
    return { success: false, error: error.message };
  }
}

// Promocja dla nieaktywnych użytkowników (nie mają subskrypcji)
async function sendPromoEmailToInactiveUsers(user) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const audience = user.role === 'provider' ? 'provider' : 'client';
    
    await sendMail({
      to: user.email,
      subject: '🎁 Wypróbuj PRO za darmo przez 7 dni!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Wypróbuj PRO za darmo! 🎁</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>Chcesz oszczędzać więcej i zarabiać więcej? Wypróbuj plan PRO za darmo przez 7 dni!</p>
            
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <h3 style="margin: 0 0 10px 0; color: #92400e;">Korzyści z PRO:</h3>
              <ul style="margin: 0; padding-left: 20px; color: #78350f; line-height: 2;">
                <li>Oszczędzaj do <strong>15%</strong> na platform fee</li>
                <li><strong>Nielimitowane</strong> odpowiedzi i zapytania AI</li>
                <li><strong>Priorytet</strong> w wynikach wyszukiwania</li>
                <li><strong>Zaawansowane statystyki</strong> i analityka</li>
              </ul>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}/account/subscriptions?audience=${audience}" 
                 style="background: #f97316; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">
                Rozpocznij trial →
              </a>
            </div>
            
            <p style="color: #6b7280; font-size: 14px; margin-top: 20px; text-align: center;">
              Anuluj w każdej chwili. Bez zobowiązań.
            </p>
          </div>
        </div>
      `
    });
    
    return { success: true };
  } catch (error) {
    console.error('Error sending promo email:', error);
    return { success: false, error: error.message };
  }
}

// Cron job do wysyłania emaili
async function runSubscriptionEmailMarketing() {
  try {
    const now = new Date();
    
    // 1. Trial reminders - 3 dni przed końcem
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const trialsEndingIn3Days = await UserSubscription.find({
      isTrial: true,
      trialEndsAt: {
        $gte: new Date(threeDaysFromNow.getTime() - 24 * 60 * 60 * 1000), // -1 dzień
        $lte: threeDaysFromNow
      }
    }).populate('user');
    
    for (const sub of trialsEndingIn3Days) {
      if (sub.user && sub.user.email) {
        await sendTrialReminderEmail(sub.user, sub);
      }
    }
    
    // 2. Trial conversion - ostatni dzień
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const trialsEndingTomorrow = await UserSubscription.find({
      isTrial: true,
      trialEndsAt: {
        $gte: now,
        $lte: tomorrow
      }
    }).populate('user');
    
    for (const sub of trialsEndingTomorrow) {
      if (sub.user && sub.user.email) {
        await sendTrialConversionEmail(sub.user, sub);
      }
    }
    
    // 3. Retention - użytkownicy którzy anulowali auto-odnowienie (7 dni przed wygaśnięciem)
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expiringSubscriptions = await UserSubscription.find({
      renews: false,
      validUntil: {
        $gte: new Date(sevenDaysFromNow.getTime() - 24 * 60 * 60 * 1000),
        $lte: sevenDaysFromNow
      },
      isTrial: false
    }).populate('user');
    
    for (const sub of expiringSubscriptions) {
      if (sub.user && sub.user.email) {
        await sendRetentionEmail(sub.user, sub);
      }
    }
    
    console.log(`Subscription email marketing: Sent ${trialsEndingIn3Days.length} trial reminders, ${trialsEndingTomorrow.length} conversion emails, ${expiringSubscriptions.length} retention emails`);
    
    return { success: true };
  } catch (error) {
    console.error('Error running subscription email marketing:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendTrialReminderEmail,
  sendTrialConversionEmail,
  sendRetentionEmail,
  sendPromoEmailToInactiveUsers,
  runSubscriptionEmailMarketing
};
