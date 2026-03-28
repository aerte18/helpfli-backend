const User = require("../models/User");
const Order = require("../models/Order");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");
const { sendMail } = require("./mailer");
const { sendPushToUser } = require("./webpush");
const { tplOfferNew, tplOfferAccepted } = require("./emailTemplates");

const FRONTEND_BASE = (
  process.env.FRONTEND_URL ||
  process.env.APP_URL ||
  "http://localhost:5173"
).replace(/\/$/, "");

/** Ścieżka w SPA (zapis w Notification.link) */
function orderInAppPath(orderId) {
  return `/orders/${orderId}`;
}

/** Pełny URL do maili i push */
function orderLink(orderId) {
  return `${FRONTEND_BASE}${orderInAppPath(orderId)}`;
}

async function notifyOfferNew({ app, orderId, offerId }) {
  const io = app.get("io");
  const offer = await Offer.findById(offerId).populate('providerId', 'name').lean();
  const order = await Order.findById(orderId).lean();
  if (!offer || !order) return;

  // klient (właściciel zlecenia)
  const clientId = order.client;
  const client = await User.findById(clientId).lean();
  
  // Utwórz powiadomienie w bazie danych
  try {
    await Notification.create({
      user: clientId,
      type: 'new_offer',
      title: 'Nowa oferta',
      message: `Otrzymałeś nową ofertę: ${offer.price || offer.amount} zł od ${offer.providerId?.name || 'wykonawcy'}`,
      link: orderInAppPath(orderId),
      metadata: {
        orderId: orderId.toString(),
        offerId: offerId.toString(),
        amount: offer.price || offer.amount
      }
    });
  } catch (error) {
    console.error("Error creating notification:", error);
  }
  
  if (client?.email) {
    try {
      await sendMail({
        to: client.email,
        subject: "Helpfli: Nowa oferta do Twojego zlecenia",
        html: tplOfferNew({ orderId, amount: offer.amount }),
      });
    } catch (e) {
      console.error("Email error:", e);
    }
  }
  
  try {
    await sendPushToUser(clientId, {
      type: "offer:new",
      title: "Nowa oferta",
      body: `Nowa oferta: ${offer.amount} zł`,
      url: orderLink(orderId)
    });
  } catch (e) {
    console.error("Push error:", e);
  }

  // Socket.IO (już robisz), tu opcjonalnie:
  if (io) io.to(`order:${orderId}`).emit("offer:new", { orderId, offerId });
}

async function notifyOfferAccepted({ app, orderId, offerId }) {
  const io = app.get("io");
  const offer = await Offer.findById(offerId).lean();
  const order = await Order.findById(orderId).lean();
  if (!offer || !order) return;

  // wykonawca
  const provider = await User.findById(offer.providerId).lean();
  if (provider?.email) {
    try {
      await sendMail({
        to: provider.email,
        subject: "Helpfli: Twoja oferta została zaakceptowana",
        html: tplOfferAccepted({ orderId, amount: offer.amount }),
      });
    } catch (e) {
      console.error("Email error:", e);
    }
  }
  
  try {
    await sendPushToUser(offer.providerId, {
      type: "offer:accepted",
      title: "Oferta zaakceptowana",
      body: `Oferta za ${offer.amount} zł została zaakceptowana`,
      url: orderLink(orderId)
    });
  } catch (e) {
    console.error("Push error:", e);
  }

  if (io) io.to(`order:${orderId}`).emit("offer:accepted", { orderId, offerId });
}

async function notifyOfferRejected({ app, orderId, offerId, providerId }) {
  const io = app.get("io");
  const offer = await Offer.findById(offerId).lean();
  const order = await Order.findById(orderId).lean();
  if (!offer || !order) return;

  // Wykonawca, którego oferta została odrzucona
  const provider = await User.findById(providerId || offer.providerId).lean();
  if (provider?.email) {
    try {
      await sendMail({
        to: provider.email,
        subject: "Helpfli: Klient wybrał inną ofertę",
        html: `
          <h2>Klient wybrał inną ofertę</h2>
          <p>Dziękujemy za złożenie oferty na zlecenie "${order.service}".</p>
          <p>Klient wybrał inną ofertę. <strong>Brak kar</strong> - Twoja oferta została zapisana w statystykach skuteczności.</p>
          <p><a href="${orderLink(orderId)}">Zobacz szczegóły zlecenia</a></p>
        `,
      });
    } catch (e) {
      console.error("Email error:", e);
    }
  }
  
  try {
    await sendPushToUser(providerId || offer.providerId, {
      type: "offer:rejected",
      title: "Klient wybrał inną ofertę",
      body: "Dziękujemy za złożenie oferty. Brak kar - oferta zapisana w statystykach.",
      url: orderLink(orderId)
    });
  } catch (e) {
    console.error("Push error:", e);
  }

  if (io) io.to(`order:${orderId}`).emit("offer:rejected", { orderId, offerId, providerId: providerId || offer.providerId });
}

async function notifyChangeRequest({ app, changeRequestId, orderId, clientId }) {
  const io = app.get("io");
  const ChangeRequest = require("../models/ChangeRequest");
  const changeRequest = await ChangeRequest.findById(changeRequestId).lean();
  const Order = require("../models/Order");
  const order = await Order.findById(orderId).lean();
  if (!changeRequest || !order) return;

  const client = await User.findById(clientId).lean();
  if (client?.email) {
    try {
      await sendMail({
        to: client.email,
        subject: "Helpfli: Wykonawca proponuje dopłatę",
        html: `
          <h2>Wykonawca proponuje dopłatę</h2>
          <p>Wykonawca zaproponował dopłatę w wysokości <strong>${changeRequest.amount} zł</strong>.</p>
          <p><strong>Powód:</strong> ${changeRequest.reason}</p>
          <p>Zaloguj się do aplikacji, aby zaakceptować lub odrzucić dopłatę.</p>
          <p><a href="${orderLink(orderId)}">Zobacz szczegóły zlecenia</a></p>
        `,
      });
    } catch (e) {
      console.error("Email error:", e);
    }
  }
  
  try {
    await sendPushToUser(clientId, {
      type: "change_request:new",
      title: "Propozycja dopłaty",
      body: `Wykonawca proponuje dopłatę ${changeRequest.amount} zł: ${changeRequest.reason}`,
      url: orderLink(orderId)
    });
  } catch (e) {
    console.error("Push error:", e);
  }

  if (io) io.to(`order:${orderId}`).emit("change_request:new", { orderId, changeRequestId });
}

async function notifyChangeRequestAccepted({ app, changeRequestId, orderId, providerId }) {
  const io = app.get("io");
  const ChangeRequest = require("../models/ChangeRequest");
  const changeRequest = await ChangeRequest.findById(changeRequestId).lean();
  const Order = require("../models/Order");
  const order = await Order.findById(orderId).lean();
  if (!changeRequest || !order) return;

  const provider = await User.findById(providerId).lean();
  if (provider?.email) {
    try {
      await sendMail({
        to: provider.email,
        subject: "Helpfli: Klient zaakceptował dopłatę",
        html: `
          <h2>Klient zaakceptował dopłatę</h2>
          <p>Klient zaakceptował dopłatę w wysokości <strong>${changeRequest.amount} zł</strong>.</p>
          <p>Kwota została dodana do zlecenia.</p>
          <p><a href="${orderLink(orderId)}">Zobacz szczegóły zlecenia</a></p>
        `,
      });
    } catch (e) {
      console.error("Email error:", e);
    }
  }
  
  try {
    await sendPushToUser(providerId, {
      type: "change_request:accepted",
      title: "Dopłata zaakceptowana",
      body: `Klient zaakceptował dopłatę ${changeRequest.amount} zł`,
      url: orderLink(orderId)
    });
  } catch (e) {
    console.error("Push error:", e);
  }

  if (io) io.to(`order:${orderId}`).emit("change_request:accepted", { orderId, changeRequestId });
}

async function notifyChangeRequestRejected({ app, changeRequestId, orderId, providerId }) {
  const io = app.get("io");
  const ChangeRequest = require("../models/ChangeRequest");
  const changeRequest = await ChangeRequest.findById(changeRequestId).lean();
  const Order = require("../models/Order");
  const order = await Order.findById(orderId).lean();
  if (!changeRequest || !order) return;

  const provider = await User.findById(providerId).lean();
  if (provider?.email) {
    try {
      await sendMail({
        to: provider.email,
        subject: "Helpfli: Klient odrzucił dopłatę",
        html: `
          <h2>Klient odrzucił dopłatę</h2>
          <p>Klient odrzucił propozycję dopłaty w wysokości <strong>${changeRequest.amount} zł</strong>.</p>
          <p>${changeRequest.clientMessage ? `Komentarz klienta: ${changeRequest.clientMessage}` : ''}</p>
          <p>Realizuj zlecenie zgodnie z pierwotnym zakresem.</p>
          <p><a href="${orderLink(orderId)}">Zobacz szczegóły zlecenia</a></p>
        `,
      });
    } catch (e) {
      console.error("Email error:", e);
    }
  }
  
  try {
    await sendPushToUser(providerId, {
      type: "change_request:rejected",
      title: "Dopłata odrzucona",
      body: `Klient odrzucił propozycję dopłaty ${changeRequest.amount} zł`,
      url: orderLink(orderId)
    });
  } catch (e) {
    console.error("Push error:", e);
  }

  if (io) io.to(`order:${orderId}`).emit("change_request:rejected", { orderId, changeRequestId });
}

// Powiadomienie o nowym zleceniu dla providerów
async function notifyOrderNew({ app, orderId, providerIds = [] }) {
  const io = app.get("io");
  const order = await Order.findById(orderId).populate('client', 'name').lean();
  if (!order) return;

  // Jeśli nie podano providerIds, znajdź wszystkich providerów w okolicy
  let targetProviders = providerIds;
  if (targetProviders.length === 0) {
    // TODO: Znajdź providerów w okolicy na podstawie lokalizacji zlecenia
    // Na razie pomijamy automatyczne powiadomienia dla wszystkich providerów
    return;
  }

  // Utwórz powiadomienia dla każdego providera
  for (const providerId of targetProviders) {
    try {
      await Notification.create({
        user: providerId,
        type: 'new_order',
        title: 'Nowe zlecenie',
        message: `Nowe zlecenie: ${order.service} w ${order.location?.city || 'Twojej okolicy'}`,
        link: orderInAppPath(orderId),
        metadata: {
          orderId: orderId.toString(),
          service: order.service,
          city: order.location?.city || null
        }
      });
    } catch (error) {
      console.error(`Error creating notification for provider ${providerId}:`, error);
    }
  }

  // Socket.IO
  if (io) {
    targetProviders.forEach(providerId => {
      io.to(`user:${providerId}`).emit("order:new", { orderId });
    });
  }
}

// Powiadomienie o zmianach w zleceniu
async function notifyOrderUpdated({ app, orderId, changes, recipientIds = [] }) {
  const io = app.get("io");
  const order = await Order.findById(orderId).lean();
  if (!order) return;

  // Jeśli nie podano odbiorców, użyj klienta i zaakceptowanego providera
  let recipients = recipientIds;
  if (recipients.length === 0) {
    recipients = [order.client];
    if (order.acceptedOfferId) {
      const offer = await Offer.findById(order.acceptedOfferId).lean();
      if (offer?.providerId) {
        recipients.push(offer.providerId);
      }
    }
  }

  const changeDescription = Object.keys(changes).join(', ');

  // Utwórz powiadomienia dla każdego odbiorcy
  for (const recipientId of recipients) {
    try {
      await Notification.create({
        user: recipientId,
        type: 'order_updated',
        title: 'Zmiany w zleceniu',
        message: `Zlecenie zostało zaktualizowane: ${changeDescription}`,
        link: orderInAppPath(orderId),
        metadata: {
          orderId: orderId.toString(),
          changes: changes
        }
      });
    } catch (error) {
      console.error(`Error creating notification for user ${recipientId}:`, error);
    }
  }

  // Socket.IO
  if (io) {
    recipients.forEach(recipientId => {
      io.to(`user:${recipientId}`).emit("order:updated", { orderId, changes });
    });
  }
}

// Powiadomienie o nowej wiadomości czatu
async function notifyChatMessage({ io, conversationId, messageId, senderId, recipientIds = [] }) {
  const Conversation = require("../models/Conversation");
  const Message = require("../models/Message");
  
  const message = await Message.findById(messageId).populate('sender', 'name').lean();
  const conversation = await Conversation.findById(conversationId).lean();
  if (!message || !conversation) return;

  // Jeśli nie podano odbiorców, użyj uczestników konwersacji (oprócz nadawcy)
  let recipients = recipientIds;
  if (recipients.length === 0) {
    recipients = conversation.participants
      .map(p => p.toString())
      .filter(p => p !== senderId.toString());
  }

  const orderRef = conversation.order
    ? String(conversation.order)
    : null;
  const chatLink = orderRef
    ? `/orders/${orderRef}/chat`
    : "/messages";

  // Utwórz powiadomienia dla każdego odbiorcy
  for (const recipientId of recipients) {
    try {
      await Notification.create({
        user: recipientId,
        type: 'chat_message',
        title: `Nowa wiadomość od ${message.sender?.name || 'użytkownika'}`,
        message: message.text?.substring(0, 100) || 'Nowa wiadomość',
        link: chatLink,
        metadata: {
          conversationId: conversationId.toString(),
          messageId: messageId.toString(),
          senderId: senderId.toString(),
          ...(orderRef ? { orderId: orderRef } : {}),
        }
      });
    } catch (error) {
      console.error(`Error creating chat notification for user ${recipientId}:`, error);
    }
  }

  // Socket.IO
  if (io) {
    recipients.forEach(recipientId => {
      io.to(`user:${recipientId}`).emit("chat:new_message", { conversationId, messageId });
    });
  }
}

module.exports = { 
  notifyOfferNew, 
  notifyOfferAccepted, 
  notifyOfferRejected,
  notifyChangeRequest,
  notifyChangeRequestAccepted,
  notifyChangeRequestRejected,
  notifyOrderNew,
  notifyOrderUpdated,
  notifyChatMessage
};
