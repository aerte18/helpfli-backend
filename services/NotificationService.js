const User = require('../models/User');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const { sendMail } = require('../utils/mailer');
const { sendPushToUser } = require('../utils/push');

class NotificationService {
  constructor() {
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  // Helper do generowania linków
  getOrderLink(orderId) {
    return `${this.frontendUrl}/orders/${orderId}`;
  }

  getProfileLink(userId) {
    return `${this.frontendUrl}/profile/${userId}`;
  }

  getCompanyLink() {
    return `${this.frontendUrl}/account/company`;
  }

  // Email templates
  getEmailTemplate(type, data) {
    const templates = {
      order_accepted: {
        subject: 'Helpfli: Zlecenie zostało przyjęte',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4F46E5;">Zlecenie zostało przyjęte!</h2>
            <p>Cześć ${data.clientName || ''},</p>
            <p>Wykonawca <strong>${data.providerName || ''}</strong> przyjął Twoje zlecenie <strong>"${data.service || ''}"</strong>.</p>
            <p>Teraz możesz zabezpieczyć środki w systemie escrow:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.getOrderLink(data.orderId)}" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Zabezpiecz środki
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },
      
      order_funded: {
        subject: 'Helpfli: Środki zabezpieczone - możesz rozpocząć pracę',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">Środki zabezpieczone!</h2>
            <p>Cześć ${data.providerName || ''},</p>
            <p>Klient zabezpieczył środki za zlecenie <strong>"${data.service || ''}"</strong>.</p>
            <p>Możesz teraz rozpocząć pracę:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.getOrderLink(data.orderId)}" 
                 style="background: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Rozpocznij pracę
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      order_completed: {
        subject: 'Helpfli: Zlecenie zostało zakończone',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">Zlecenie zakończone!</h2>
            <p>Cześć ${data.clientName || ''},</p>
            <p>Wykonawca zakończył pracę nad zleceniem <strong>"${data.service || ''}"</strong>.</p>
            <p>Sprawdź jakość wykonania i potwierdź odbiór:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.getOrderLink(data.orderId)}" 
                 style="background: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Potwierdź odbiór
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      order_disputed: {
        subject: 'Helpfli: Zgłoszono spór',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #DC2626;">Zgłoszono spór</h2>
            <p>Cześć,</p>
            <p>Zgłoszono spór dotyczący zlecenia <strong>"${data.service || ''}"</strong>.</p>
            ${data.reason ? `<p><strong>Powód:</strong> ${data.reason}</p>` : ''}
            <p>Nasz zespół rozpatrzy sprawę w ciągu 24 godzin.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.getOrderLink(data.orderId)}" 
                 style="background: #DC2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Zobacz szczegóły
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      new_quote: {
        subject: 'Helpfli: Nowa wycena do Twojego zlecenia',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4F46E5;">Nowa wycena!</h2>
            <p>Cześć ${data.clientName || ''},</p>
            <p>Wykonawca <strong>${data.providerName || ''}</strong> przesłał wycenę do Twojego zlecenia <strong>"${data.service || ''}"</strong>.</p>
            <p><strong>Cena:</strong> ${data.price || 'Do uzgodnienia'} zł</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.getOrderLink(data.orderId)}" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Zobacz wycenę
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      payment_received: {
        subject: 'Helpfli: Płatność otrzymana',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">Płatność otrzymana!</h2>
            <p>Cześć ${data.providerName || ''},</p>
            <p>Otrzymałeś płatność w wysokości <strong>${data.amount || ''} zł</strong> za zlecenie <strong>"${data.service || ''}"</strong>.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.getOrderLink(data.orderId)}" 
                 style="background: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Zobacz szczegóły
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      client_invoice_issued: {
        subject: 'Helpfli: Twoja faktura za zlecenie jest gotowa',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4F46E5;">Faktura za zlecenie "${data.service || ''}"</h2>
            <p>Cześć ${data.clientName || ''},</p>
            <p>Wystawiliśmy fakturę <strong>${data.invoiceNumber || ''}</strong> za opłacone zlecenie.</p>
            <p>Możesz ją pobrać w swoim koncie Helpfli lub klikając przycisk poniżej.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.frontendUrl}/account?tab=invoices" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Otwórz faktury
              </a>
            </div>
            <p style="font-size: 12px; color: #6B7280;">
              Link do szczegółów zlecenia: <a href="${this.getOrderLink(data.orderId)}">${this.getOrderLink(data.orderId)}</a>
            </p>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      company_created: {
        subject: 'Helpfli: Firma została utworzona!',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4F46E5;">Witaj w Helpfli B2B! 🏢</h2>
            <p>Cześć ${data.userName || ''},</p>
            <p>Gratulujemy! Twoja firma <strong>"${data.companyName || ''}"</strong> została pomyślnie utworzona w systemie Helpfli.</p>
            <p>Teraz masz dostęp do zaawansowanych funkcji B2B:</p>
            <ul style="list-style: none; padding: 0;">
              <li style="margin: 10px 0;">✅ Zarządzanie zespołem i uprawnieniami</li>
              <li style="margin: 10px 0;">✅ Wspólne limity AI Concierge i odpowiedzi</li>
              <li style="margin: 10px 0;">✅ Analityka wydajności zespołu</li>
              <li style="margin: 10px 0;">✅ Portfel firmowy i faktury</li>
              <li style="margin: 10px 0;">✅ Automatyzacja workflow</li>
            </ul>
            <p><strong>Następne kroki:</strong></p>
            <ol style="padding-left: 20px;">
              <li style="margin: 5px 0;">Dodaj członków zespołu</li>
              <li style="margin: 5px 0;">Skonfiguruj workflow automatycznego przypisania zleceń</li>
              <li style="margin: 5px 0;">Wybierz plan biznesowy dostosowany do Twoich potrzeb</li>
            </ol>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.frontendUrl}/account/company" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Przejdź do panelu firmy
              </a>
            </div>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      company_account_created: {
        subject: 'Helpfli: Twoje konto wykonawcy zostało utworzone',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4F46E5;">Witaj w Helpfli! 👋</h2>
            <p>Cześć ${data.providerName || ''},</p>
            <p>Firma <strong>"${data.companyName || ''}"</strong> utworzyła dla Ciebie konto wykonawcy w systemie Helpfli.</p>
            <p><strong>Twoje dane do logowania:</strong></p>
            <div style="background: #F3F4F6; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 5px 0;"><strong>Email:</strong> ${data.email || ''}</p>
              <p style="margin: 5px 0;"><strong>Tymczasowe hasło:</strong> <code style="background: white; padding: 4px 8px; border-radius: 4px;">${data.tempPassword || ''}</code></p>
            </div>
            <p style="color: #DC2626; font-weight: bold;">⚠️ Ważne: Musisz zmienić hasło przy pierwszym logowaniu!</p>
            <p>Po zalogowaniu będziesz mógł:</p>
            <ul style="list-style: none; padding: 0;">
              <li style="margin: 10px 0;">✅ Składać oferty na zlecenia</li>
              <li style="margin: 10px 0;">✅ Korzystać z limitów firmy (AI Concierge, Fast-Track, odpowiedzi)</li>
              <li style="margin: 10px 0;">✅ Zarządzać swoim profilem wykonawcy</li>
              <li style="margin: 10px 0;">✅ Otrzymywać zlecenia przypisane przez firmę</li>
            </ul>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.frontendUrl}/login?token=${data.activationToken || ''}" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Zaloguj się i zmień hasło
              </a>
            </div>
            <p style="font-size: 12px; color: #6B7280;">
              Link aktywacyjny jest ważny przez 7 dni. Jeśli nie aktywujesz konta w tym czasie, skontaktuj się z administratorem firmy.
            </p>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      },

      company_invitation: {
        subject: 'Helpfli: Zaproszenie do firmy',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #4F46E5;">Zaproszenie do firmy 🏢</h2>
            <p>Cześć,</p>
            <p><strong>${data.inviterName || ''}</strong> zaprosił Cię do dołączenia do firmy <strong>"${data.companyName || ''}"</strong> w systemie Helpfli.</p>
            <p>Po zaakceptowaniu zaproszenia będziesz mógł:</p>
            <ul style="list-style: none; padding: 0;">
              <li style="margin: 10px 0;">✅ Korzystać z limitów firmy (AI Concierge, Fast-Track, odpowiedzi)</li>
              <li style="margin: 10px 0;">✅ Otrzymywać zlecenia przypisane przez firmę</li>
              <li style="margin: 10px 0;">✅ Współpracować z zespołem firmy</li>
            </ul>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.frontendUrl}/account?tab=company-invitations" 
                 style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Zobacz zaproszenia
              </a>
            </div>
            <p style="font-size: 12px; color: #6B7280;">
              Zaproszenie jest ważne przez 7 dni.
            </p>
            <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
          </div>
        `
      }
    };

    return templates[type] || null;
  }

  // Push notification templates
  getPushTemplate(type, data) {
    const templates = {
      order_accepted: {
        title: 'Zlecenie przyjęte!',
        message: `${data.providerName || 'Wykonawca'} przyjął Twoje zlecenie "${data.service || ''}"`
      },
      
      order_funded: {
        title: 'Środki zabezpieczone',
        message: `Klient zabezpieczył środki za zlecenie "${data.service || ''}" - możesz rozpocząć pracę`
      },

      order_completed: {
        title: 'Zlecenie zakończone',
        message: `Wykonawca zakończył pracę nad zleceniem "${data.service || ''}" - potwierdź odbiór`
      },

      order_disputed: {
        title: 'Zgłoszono spór',
        message: `Spór dotyczący zlecenia "${data.service || ''}" - nasz zespół go rozpatrzy`
      },

      new_quote: {
        title: 'Nowa wycena',
        message: `${data.providerName || 'Wykonawca'} przesłał wycenę: ${data.price || 'Do uzgodnienia'} zł`
      },

      payment_received: {
        title: 'Płatność otrzymana',
        message: `Otrzymałeś ${data.amount || ''} zł za zlecenie "${data.service || ''}"`
      },

      company_created: {
        title: 'Firma utworzona! 🏢',
        message: `Twoja firma "${data.companyName || ''}" została utworzona. Rozpocznij konfigurację!`
      },

      company_account_created: {
        title: 'Konto utworzone! 👋',
        message: `Firma "${data.companyName || ''}" utworzyła dla Ciebie konto. Sprawdź email z danymi do logowania.`
      },

      company_invitation: {
        title: 'Zaproszenie do firmy 🏢',
        message: `Zostałeś zaproszony do firmy "${data.companyName || ''}" przez ${data.inviterName || ''}`
      }
    };

    return templates[type] || { title: 'Helpfli', message: 'Nowe powiadomienie' };
  }

  // Główna metoda wysyłania powiadomień
  async sendNotification(type, recipients, data) {
    const emailTemplate = this.getEmailTemplate(type, data);
    const pushTemplate = this.getPushTemplate(type, data);

    // Pobierz dane użytkowników
    const users = await User.find({ _id: { $in: recipients } }).lean();
    
    for (const user of users) {
      // Zapisz powiadomienie w bazie danych
      try {
        const metadata = {};
        if (data.orderId) metadata.orderId = data.orderId;
        if (data.userId) metadata.userId = data.userId;
        if (data.amount) metadata.amount = data.amount;
        if (data.subscriptionId) metadata.subscriptionId = data.subscriptionId;
        if (data.metadata) {
          Object.assign(metadata, data.metadata);
        }
        
        await Notification.create({
          user: user._id,
          type,
          title: pushTemplate.title,
          message: pushTemplate.message,
          link: data.orderId ? this.getOrderLink(data.orderId) : (type === 'company_created' ? this.getCompanyLink() : null),
          metadata: Object.keys(metadata).length > 0 ? metadata : {}
        });
      } catch (error) {
        console.error(`Error saving notification for ${user._id}:`, error);
      }

      // Email
      if (user.email && emailTemplate) {
        try {
          await sendMail({
            to: user.email,
            subject: emailTemplate.subject,
            html: emailTemplate.html
          });
          console.log(`Email sent to ${user.email} for ${type}`);
        } catch (error) {
          console.error(`Email error for ${user.email}:`, error);
        }
      }

      // Push notification
      try {
        await sendPushToUser(user._id, {
          title: pushTemplate.title,
          message: pushTemplate.message,
          url: data.orderId ? this.getOrderLink(data.orderId) : (data.companyId ? `${this.frontendUrl}/account/company` : this.frontendUrl)
        });
        console.log(`Push sent to ${user._id} for ${type}`);
      } catch (error) {
        console.error(`Push error for ${user._id}:`, error);
      }
    }
  }

  // Metody dla konkretnych zdarzeń
  async notifyOrderAccepted(orderId) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .lean();

    if (!order) return;

    await this.sendNotification('order_accepted', [order.client._id], {
      clientName: order.client.name,
      providerName: order.provider.name,
      service: order.service,
      orderId
    });
  }

  async notifyOrderFunded(orderId) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .lean();

    if (!order) return;

    await this.sendNotification('order_funded', [order.provider._id], {
      providerName: order.provider.name,
      clientName: order.client.name,
      service: order.service,
      orderId
    });
  }

  async notifyOrderCompleted(orderId) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .lean();

    if (!order) return;

    await this.sendNotification('order_completed', [order.client._id], {
      clientName: order.client.name,
      providerName: order.provider.name,
      service: order.service,
      orderId
    });
  }

  async notifyOrderDisputed(orderId, reason) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .lean();

    if (!order) return;

    // Powiadom obie strony
    const recipients = [order.client._id, order.provider._id];
    
    await this.sendNotification('order_disputed', recipients, {
      clientName: order.client.name,
      providerName: order.provider.name,
      service: order.service,
      orderId,
      reason
    });
  }

  async notifyNewQuote(orderId, providerId) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .lean();
    
    const provider = await User.findById(providerId).lean();

    if (!order || !provider) return;

    await this.sendNotification('new_quote', [order.client._id], {
      clientName: order.client.name,
      providerName: provider.name,
      service: order.service,
      orderId
    });
  }

  async notifyNewDirectOrder(orderId, providerId, clientId) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .lean();
    
    const provider = await User.findById(providerId).lean();

    if (!order || !provider) return;

    // Dodaj template dla bezpośredniego zlecenia
    const emailTemplate = {
      subject: 'Helpfli: Nowe bezpośrednie zlecenie',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">Nowe bezpośrednie zlecenie!</h2>
          <p>Cześć ${provider.name || ''},</p>
          <p>Klient <strong>${order.client.name || ''}</strong> wysłał Ci bezpośrednie zlecenie <strong>"${order.service || ''}"</strong>.</p>
          <p><strong>Opis:</strong> ${order.description || 'Brak opisu'}</p>
          ${order.location ? `<p><strong>Lokalizacja:</strong> ${order.location}</p>` : ''}
          <div style="text-align: center; margin: 30px 0;">
            <a href="${this.getOrderLink(orderId)}" 
               style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Zobacz zlecenie
            </a>
          </div>
          <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
        </div>
      `
    };

    const pushTemplate = {
      title: 'Nowe bezpośrednie zlecenie',
      message: `${order.client.name || 'Klient'} wysłał Ci zlecenie "${order.service || ''}"`
    };

    // Wyślij email
    if (provider.email) {
      try {
        const { sendMail } = require('../utils/mailer');
        await sendMail({
          to: provider.email,
          subject: emailTemplate.subject,
          html: emailTemplate.html
        });
        console.log(`Direct order email sent to ${provider.email}`);
      } catch (error) {
        console.error(`Direct order email error:`, error);
      }
    }

    // Wyślij push
    try {
      const { sendPushToUser } = require('../utils/push');
      await sendPushToUser(providerId, {
        title: pushTemplate.title,
        message: pushTemplate.message,
        url: this.getOrderLink(orderId)
      });
      console.log(`Direct order push sent to ${providerId}`);
    } catch (error) {
      console.error(`Direct order push error:`, error);
    }
  }

  async notifyPaymentReceived(orderId) {
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .lean();

    if (!order) return;

    await this.sendNotification('payment_received', [order.provider._id], {
      providerName: order.provider.name,
      service: order.service,
      amount: (order.amountTotal / 100).toFixed(2),
      orderId
    });
  }
}

module.exports = new NotificationService();

