?const User = require('../models/User');
const Order = require('../models/Order');
const { sendMail } = require('../utils/mailer');

/**
 * Email Marketing Automation
 * Welcome series, abandoned cart, re-engagement
 */

// Welcome Series - Email 1: Witamy + jak korzystać z platformy
async function sendWelcomeEmail1(user) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const role = user.role === 'provider' ? 'wykonawcy' : 'klienta';
    
    await sendMail({
      to: user.email,
      subject: 'Witamy w Helpfli! 🎉',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Witamy w Helpfli!</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>Dziękujemy za dołączenie do Helpfli! Jesteśmy podekscytowani, że jesteś z nami.</p>
            
            <h2 style="color: #667eea; margin-top: 30px;">Jak zacząć?</h2>
            ${user.role === 'provider' ? `
              <ol style="line-height: 1.8;">
                <li><strong>Uzupełnij profil</strong> - dodaj zdjęcie, opis i swoje usługi</li>
                <li><strong>Zweryfikuj się (KYC)</strong> - to otworzy dostęp do wszystkich funkcji</li>
                <li><strong>Przeglądaj zlecenia</strong> - znajdź zlecenia w Twojej okolicy</li>
                <li><strong>Składaj oferty</strong> - odpowiadaj na zlecenia i zdobywaj klientów</li>
              </ol>
            ` : `
              <ol style="line-height: 1.8;">
                <li><strong>Opisz problem</strong> - użyj AI Concierge lub utwórz zlecenie</li>
                <li><strong>Wybierz wykonawcę</strong> - porównaj oferty i wybierz najlepszą</li>
                <li><strong>Zabezpiecz płatność</strong> - bezpieczne płatności przez Helpfli</li>
                <li><strong>Oceń wykonawcę</strong> - pomóż innym użytkownikom</li>
              </ol>
            `}
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}${user.role === 'provider' ? '/provider-home' : '/home'}" 
                 style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                Rozpocznij teraz →
              </a>
            </div>
            
            <p style="margin-top: 30px; color: #666; font-size: 14px;">
              Pytania? Odpowiedz na ten email lub skontaktuj się z nami przez platformę.
            </p>
            
            <p style="margin-top: 20px;">Pozdrawiamy,<br/><strong>Zespół Helpfli</strong></p>
          </div>
        </div>
      `
    });
    
    console.log(`Welcome email 1 sent to ${user.email}`);
    return true;
  } catch (error) {
    console.error('Error sending welcome email 1:', error);
    return false;
  }
}

// Welcome Series - Email 2: Porady jak znaleźć najlepszego wykonawcę / jak zdobyć więcej zleceń
async function sendWelcomeEmail2(user) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    await sendMail({
      to: user.email,
      subject: `💡 Porady: Jak ${user.role === "provider" ? "zdobyć więcej zleceń" : "znaleźć najlepszego wykonawcę"}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">💡 Porady Helpfli</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>Mamy dla Ciebie kilka porad, które pomogą Ci ${user.role === 'provider' ? 'zdobyć więcej zleceń' : 'znaleźć najlepszego wykonawcę'}!</p>
            
            ${user.role === 'provider' ? `
              <h2 style="color: #f5576c; margin-top: 30px;">Jak zdobyć więcej zleceń?</h2>
              <ul style="line-height: 1.8;">
                <li><strong>Kompletny profil</strong> - użytkownicy częściej wybierają wykonawców z pełnym profilem i zdjęciami</li>
                <li><strong>Szybkie odpowiedzi</strong> - odpowiadaj na zlecenia w ciągu 2 godzin, zwiększasz szanse o 3x</li>
                <li><strong>Konkurencyjne ceny</strong> - sprawdź widełki cenowe przed złożeniem oferty</li>
                <li><strong>Zbieraj opinie</strong> - poproś klientów o ocenę po zakończeniu zlecenia</li>
                <li><strong>Pakiet PRO</strong> - zwiększ widoczność i zdejmij limity odpowiedzi</li>
              </ul>
            ` : `
              <h2 style="color: #f5576c; margin-top: 30px;">Jak znaleźć najlepszego wykonawcę?</h2>
              <ul style="line-height: 1.8;">
                <li><strong>Sprawdź oceny</strong> - wykonawcy z 4.5+ gwiazdkami to sprawdzone opcje</li>
                <li><strong>Czytaj opinie</strong> - szczegóły w recenzjach pomagają wybrać najlepszego</li>
                <li><strong>Porównaj oferty</strong> - nie wybieraj najtańszej, wybierz najlepszą wartość</li>
                <li><strong>Użyj AI Concierge</strong> - AI pomoże znaleźć najlepszych wykonawców</li>
                <li><strong>Zweryfikowani wykonawcy</strong> - szukaj badge'a "Verified"</li>
              </ul>
            `}
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}${user.role === 'provider' ? '/provider-home' : '/home'}" 
                 style="background: #f5576c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                ${user.role === 'provider' ? 'Zobacz dostępne zlecenia' : 'Znajdź wykonawcę'}
              </a>
            </div>
            
            <p style="margin-top: 30px; color: #666; font-size: 14px;">
              Masz pytania? Jesteśmy tutaj, aby pomóc!
            </p>
            
            <p style="margin-top: 20px;">Pozdrawiamy,<br/><strong>Zespół Helpfli</strong></p>
          </div>
        </div>
      `
    });
    
    console.log(`Welcome email 2 sent to ${user.email}`);
    return true;
  } catch (error) {
    console.error('Error sending welcome email 2:', error);
    return false;
  }
}

// Welcome Series - Email 3: Case study - jak inni korzystają z Helpfli
async function sendWelcomeEmail3(user) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    await sendMail({
      to: user.email,
      subject: '📊 Case study: Jak inni korzystają z Helpfli',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">📊 Case Study</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>Chcesz zobaczyć, jak inni użytkownicy korzystają z Helpfli? Oto kilka przykładów:</p>
            
            ${user.role === 'provider' ? `
              <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #4facfe; margin-top: 0;">💼 Jan Kowalski - Hydraulik</h3>
                <p><strong>Wynik:</strong> 50+ zleceń w pierwszym miesiącu</p>
                <p><strong>Jak to zrobił:</strong></p>
                <ul style="line-height: 1.8;">
                  <li>Uzupełnił profil w 100%</li>
                  <li>Odpowiadał na zlecenia w ciągu 1 godziny</li>
                  <li>Zbierał opinie po każdym zleceniu</li>
                  <li>Użył pakietu PRO dla większej widoczności</li>
                </ul>
              </div>
              
              <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #4facfe; margin-top: 0;">🔧 Anna Nowak - Elektryk</h3>
                <p><strong>Wynik:</strong> 4.9/5 gwiazdek, 100+ zrealizowanych zleceń</p>
                <p><strong>Sekret sukcesu:</strong> Zawsze używała AI Concierge do analizy zleceń i składania optymalnych ofert.</p>
              </div>
            ` : `
              <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #4facfe; margin-top: 0;">🏠 Maria Wiśniewska</h3>
                <p><strong>Problem:</strong> Potrzebowała hydraulika do naprawy kranu</p>
                <p><strong>Rozwiązanie:</strong> Użyła AI Concierge, który znalazł 3 najlepszych wykonawców w jej okolicy</p>
                <p><strong>Rezultat:</strong> Naprawa w ciągu 2 godzin, cena 30% niższa niż u konkurencji</p>
              </div>
              
              <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #4facfe; margin-top: 0;">🏢 Firma XYZ</h3>
                <p><strong>Potrzeba:</strong> Regularne usługi sprzątające</p>
                <p><strong>Rozwiązanie:</strong> Utworzyła zlecenie cykliczne, znalazła sprawdzonego wykonawcę</p>
                <p><strong>Rezultat:</strong> Oszczędność 40% kosztów vs. tradycyjne firmy sprzątające</p>
              </div>
            `}
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}${user.role === 'provider' ? '/provider-home' : '/create-order'}" 
                 style="background: #4facfe; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                ${user.role === 'provider' ? 'Zobacz dostępne zlecenia' : 'Utwórz zlecenie'}
              </a>
            </div>
            
            <p style="margin-top: 30px; color: #666; font-size: 14px;">
              Chcesz być następnym sukcesem? Zacznij już dziś!
            </p>
            
            <p style="margin-top: 20px;">Pozdrawiamy,<br/><strong>Zespół Helpfli</strong></p>
          </div>
        </div>
      `
    });
    
    console.log(`Welcome email 3 sent to ${user.email}`);
    return true;
  } catch (error) {
    console.error('Error sending welcome email 3:', error);
    return false;
  }
}

// Abandoned Cart Recovery - dla niedokończonych zleceń
async function sendAbandonedCartEmail(user, orderId) {
  try {
    const order = await Order.findById(orderId);
    if (!order) return false;
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    // Oblicz czas od utworzenia zlecenia
    const hoursSinceCreation = Math.floor((new Date() - order.createdAt) / (1000 * 60 * 60));
    const urgencyMessage = hoursSinceCreation >= 24 
      ? 'Twoje zlecenie czeka już ponad 24 godziny!' 
      : `Twoje zlecenie czeka już ${hoursSinceCreation} godzin`;
    
    await sendMail({
      to: user.email,
      subject: '⏰ Dokończ swoje zlecenie w Helpfli',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">⏰ Dokończ swoje zlecenie</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>${urgencyMessage}. Dokończ zlecenie, aby znaleźć najlepszego wykonawcę!</p>
            
            <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #fa709a;">
              <h3 style="color: #fa709a; margin-top: 0;">Twoje zlecenie:</h3>
              <p><strong>Usługa:</strong> ${order.service || 'Nie określono'}</p>
              ${order.description ? `<p><strong>Opis:</strong> ${order.description.substring(0, 100)}${order.description.length > 100 ? '...' : ''}</p>` : ''}
              ${order.location ? `<p><strong>Lokalizacja:</strong> ${order.location}</p>` : ''}
            </div>
            
            <p><strong>Dokończ zlecenie w ciągu 24 godzin, a otrzymasz:</strong></p>
            <ul style="line-height: 1.8;">
              <li>✅ Szybszą odpowiedź od wykonawców</li>
              <li>✅ Priorytet w wynikach wyszukiwania</li>
              <li>✅ 10 punktów lojalnościowych za pierwsze zlecenie</li>
              <li>✅ ${hoursSinceCreation >= 24 ? 'SPECJALNA ZNIŻKA 5%' : 'Możliwość wyboru najlepszej oferty'}</li>
            </ul>
            
            ${hoursSinceCreation >= 24 ? `
              <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
                <p style="margin: 0; font-weight: bold; color: #92400e;">
                  🎁 Specjalna oferta: Dokończ zlecenie teraz i otrzymaj 5% zniżki na pierwszą płatność!
                </p>
              </div>
            ` : ''}
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}/orders/${orderId}" 
                 style="background: #fa709a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                Dokończ zlecenie →
              </a>
            </div>
            
            <p style="margin-top: 30px; color: #666; font-size: 14px;">
              Potrzebujesz pomocy? Skontaktuj się z nami!
            </p>
            
            <p style="margin-top: 20px;">Pozdrawiamy,<br/><strong>Zespół Helpfli</strong></p>
          </div>
        </div>
      `
    });
    
    console.log(`Abandoned cart email sent to ${user.email} for order ${orderId} (${hoursSinceCreation}h old)`);
    return true;
  } catch (error) {
    console.error('Error sending abandoned cart email:', error);
    return false;
  }
}

// Abandoned Cart Recovery - SMS (jeśli użytkownik ma numer telefonu)
async function sendAbandonedCartSMS(user, orderId) {
  try {
    if (!user.phone) return false;
    
    const order = await Order.findById(orderId);
    if (!order) return false;
    
    // Sprawdź czy użytkownik wyraził zgodę na SMS (opcjonalne)
    // Na razie wysyłamy tylko jeśli ma numer telefonu
    
    const hoursSinceCreation = Math.floor((new Date() - order.createdAt) / (1000 * 60 * 60));
    const message = `Helpfli: Dokończ swoje zlecenie "${order.service || 'usługa'}"! ${hoursSinceCreation >= 24 ? 'SPECJALNA ZNIŻKA 5%' : 'Szybsza odpowiedź od wykonawców'}. ${process.env.FRONTEND_URL || 'https://helpfli.pl'}/orders/${orderId}`;
    
    // TODO: Integracja z dostawcą SMS (np. Twilio, SMSAPI)
    // Na razie tylko logujemy
    console.log(`[SMS] Abandoned cart SMS to ${user.phone}: ${message}`);
    
    // Przykładowa integracja (odkomentuj gdy dodasz dostawcę SMS):
    /*
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: user.phone
    });
    */
    
    return true;
  } catch (error) {
    console.error('Error sending abandoned cart SMS:', error);
    return false;
  }
}

// Re-engagement - dla nieaktywnych użytkowników
async function sendReEngagementEmail(user, daysInactive) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    let subject = '';
    let message = '';
    
    if (daysInactive === 7) {
      subject = '👋 Wróć do Helpfli - mamy dla Ciebie coś specjalnego!';
      message = 'Minął tydzień od Twojej ostatniej wizyty. Wróć i sprawdź, co nowego!';
    } else if (daysInactive === 14) {
      subject = '🎁 Specjalna oferta tylko dla Ciebie!';
      message = 'Minęły 2 tygodnie. Mamy dla Ciebie specjalną ofertę - sprawdź!';
    } else if (daysInactive >= 30) {
      subject = '💎 Oferta powrotu - 20% zniżki na pakiet PRO!';
      message = 'Minął miesiąc. Wróć do Helpfli i otrzymaj 20% zniżki na pakiet PRO!';
    } else {
      return false; // Nie wysyłaj dla innych wartości
    }
    
    await sendMail({
      to: user.email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Wróć do Helpfli!</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p>Cześć ${user.name || ''},</p>
            <p>${message}</p>
            
            ${daysInactive >= 30 ? `
              <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
                <h3 style="color: #667eea; margin-top: 0;">🎁 Specjalna oferta powrotu</h3>
                <p><strong>20% zniżki na pakiet PRO</strong> - tylko dla Ciebie!</p>
                <p>Kod promocyjny: <strong>WROC20</strong></p>
                <p style="font-size: 12px; color: #666;">Ważny przez 7 dni</p>
              </div>
            ` : ''}
            
            <h2 style="color: #667eea; margin-top: 30px;">Co nowego w Helpfli?</h2>
            <ul style="line-height: 1.8;">
              <li>✨ AI Concierge - inteligentny asystent do rozwiązywania problemów</li>
              <li>📹 AI Camera Assistant - analiza problemów na żywo przez kamerę</li>
              <li>🎁 Program polecający - zarabiaj punkty za zaproszenia</li>
              <li>⚡ Pilne zlecenia - szybsza odpowiedź od wykonawców</li>
            </ul>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}${user.role === 'provider' ? '/provider-home' : '/home'}" 
                 style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                Wróć do Helpfli →
              </a>
            </div>
            
            <p style="margin-top: 30px; color: #666; font-size: 14px;">
              Jeśli nie chcesz otrzymywać takich emaili, możesz zmienić ustawienia w swoim koncie.
            </p>
            
            <p style="margin-top: 20px;">Pozdrawiamy,<br/><strong>Zespół Helpfli</strong></p>
          </div>
        </div>
      `
    });
    
    console.log(`Re-engagement email sent to ${user.email} (${daysInactive} days inactive)`);
    return true;
  } catch (error) {
    console.error('Error sending re-engagement email:', error);
    return false;
  }
}

module.exports = {
  sendWelcomeEmail1,
  sendWelcomeEmail2,
  sendWelcomeEmail3,
  sendAbandonedCartEmail,
  sendAbandonedCartSMS,
  sendReEngagementEmail
};

