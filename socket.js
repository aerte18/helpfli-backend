const Conversation = require("./models/Conversation");
const Message = require("./models/Message");
const Order = require("./models/Order");
const Offer = require("./models/Offer");
const User = require("./models/User");
const socketAuth = require("./middleware/socketAuth");
const TelemetryService = require("./services/TelemetryService");
const { notifyChatMessage } = require("./utils/notifier");

const PRE_OFFER_PROVIDER_MESSAGE_LIMIT = 6;
const MAX_PRE_OFFER_TEXT_LENGTH = 500;
const phoneRegex = /(?:\+?\d{1,3}[\s\-\.]?)?(?:\(?\d{2,3}\)?[\s\-\.]?)?(?:\d[\s\-\.]?){7,}/gi;
const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const linkRegex = /(https?:\/\/|www\.)\S+/gi;
const socialRegex = /\b(whatsapp|telegram|messenger|instagram|ig\b|facebook|fb\b|snapchat|tiktok|discord)\b/gi;
const obfuscatedContactRegex = /\b(małpa|malpa|kropka|dot|at)\b/gi;

function moderatePreOfferText(input) {
  const text = String(input || "");
  let moderated = text;
  const hasMatch = (regex) => {
    regex.lastIndex = 0;
    const matched = regex.test(text);
    regex.lastIndex = 0;
    return matched;
  };
  const flags = {
    hadPhone: false,
    hadEmail: false,
    hadLink: false,
    hadSocial: false,
    hadObfuscatedContact: false,
  };

  if (hasMatch(phoneRegex)) {
    flags.hadPhone = true;
    moderated = moderated.replace(phoneRegex, (m) => m.replace(/\d/g, "•"));
  }
  if (hasMatch(emailRegex)) {
    flags.hadEmail = true;
    moderated = moderated.replace(emailRegex, "•••@•••.••");
  }
  if (hasMatch(linkRegex)) {
    flags.hadLink = true;
    moderated = moderated.replace(linkRegex, "[link ukryty]");
  }
  if (hasMatch(socialRegex)) {
    flags.hadSocial = true;
    moderated = moderated.replace(socialRegex, "[kontakt poza platformą ukryty]");
  }
  if (hasMatch(obfuscatedContactRegex)) {
    flags.hadObfuscatedContact = true;
    moderated = moderated.replace(obfuscatedContactRegex, "•••");
  }

  return {
    text: moderated,
    masked: Object.values(flags).some(Boolean),
    flags,
  };
}

module.exports = function initSocket(io) {
  io.use(socketAuth);

  io.on("connection", async (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);

    // Klient dołącza do konkretnej konwersacji
    socket.on("chat:join", async ({ conversationId }) => {
      if (!conversationId) return;
      const convo = await Conversation.findById(conversationId).lean();
      if (!convo) return;
      const isMember = convo.participants.some((p) => String(p) === String(userId));
      if (!isMember) return;
      socket.join(`chat:${conversationId}`);
      socket.emit("chat:joined", { conversationId });
    });

    socket.on("chat:leave", ({ conversationId }) => {
      if (!conversationId) return;
      socket.leave(`chat:${conversationId}`);
    });

    // Wysyłanie wiadomości
    socket.on("message:send", async ({ conversationId, text, attachments }) => {
      if (!conversationId || (!text && !attachments?.length)) return;
      const convo = await Conversation.findById(conversationId);
      if (!convo) return;
      const isMember = convo.participants.some((p) => String(p) === String(userId));
      if (!isMember) return;

      let finalText = text || "";
      let finalAttachments = Array.isArray(attachments) ? attachments : [];
      let policyNotice = null;
      const moderationEvents = [];

      if (convo.order) {
        const [order, sender] = await Promise.all([
          Order.findById(convo.order).select("status acceptedOfferId").lean(),
          User.findById(userId).select("role roleInCompany").lean(),
        ]);
        const isPreAccepted = order && !order.acceptedOfferId;
        const isProviderSender =
          sender?.role === "provider" ||
          sender?.roleInCompany === "provider" ||
          sender?.role === "company_owner" ||
          sender?.role === "company_manager";

        if (isPreAccepted) {
          const moderation = moderatePreOfferText(finalText);
          finalText = moderation.text;

          if (moderation.masked) {
            policyNotice =
              "Przed akceptacją oferty ukrywamy dane kontaktowe i linki. Ustal szczegóły realizacji po akceptacji.";
            moderationEvents.push({
              type: TelemetryService.eventTypes.CHAT_PREOFFER_CONTACT_MASKED,
              properties: {
                conversationId: String(conversationId),
                orderId: String(convo.order || ""),
                ...moderation.flags,
              },
            });
          }

          if (isProviderSender) {
            const hasOffer = await Offer.exists({
              orderId: convo.order,
              providerId: userId,
            });

            if (!hasOffer) {
              const sentCount = await Message.countDocuments({
                conversation: conversationId,
                sender: userId,
                deletedAt: { $exists: false },
              });

              if (sentCount >= PRE_OFFER_PROVIDER_MESSAGE_LIMIT) {
                TelemetryService.track(TelemetryService.eventTypes.CHAT_PREOFFER_LIMIT_BLOCKED, {
                  userId,
                  properties: {
                    conversationId: String(conversationId),
                    orderId: String(convo.order || ""),
                    sentCount,
                    limit: PRE_OFFER_PROVIDER_MESSAGE_LIMIT,
                  },
                });
                socket.emit("message:error", {
                  code: "pre_offer_limit_reached",
                  message:
                    "Przed złożeniem oferty możesz wysłać ograniczoną liczbę pytań. Złóż ofertę, aby kontynuować rozmowę.",
                });
                return;
              }

              if (finalAttachments.length > 0) {
                finalAttachments = [];
                policyNotice =
                  "Załączniki są dostępne po złożeniu oferty. Przed ofertą możesz wysyłać tylko krótkie pytania tekstowe.";
                moderationEvents.push({
                  type: TelemetryService.eventTypes.CHAT_PREOFFER_ATTACHMENTS_BLOCKED,
                  properties: {
                    conversationId: String(conversationId),
                    orderId: String(convo.order || ""),
                    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
                  },
                });
              }

              if (finalText.length > MAX_PRE_OFFER_TEXT_LENGTH) {
                finalText = finalText.slice(0, MAX_PRE_OFFER_TEXT_LENGTH);
                policyNotice =
                  "Przed złożeniem oferty wiadomość została skrócona. Wysyłaj krótkie pytania doprecyzowujące.";
                moderationEvents.push({
                  type: TelemetryService.eventTypes.CHAT_PREOFFER_TEXT_TRUNCATED,
                  properties: {
                    conversationId: String(conversationId),
                    orderId: String(convo.order || ""),
                    originalLength: String(text || "").length,
                    maxLength: MAX_PRE_OFFER_TEXT_LENGTH,
                  },
                });
              }
            }
          }
        }
      }

      for (const moderationEvent of moderationEvents) {
        TelemetryService.track(moderationEvent.type, {
          userId,
          properties: moderationEvent.properties || {},
        });
      }

      const msg = await Message.create({
        conversation: conversationId,
        sender: userId,
        text: finalText,
        attachments: finalAttachments,
        readBy: [userId],
      });

      convo.lastMessage = msg._id;
      convo.lastMessageAt = msg.createdAt;
      await convo.save();

      const populated = await Message.findById(msg._id).populate("sender", "name _id");
      io.to(`chat:${conversationId}`).emit("message:new", { message: populated });

      // Powiadom userów niebędących aktualnie w pokoju
      const notifyUsers = convo.participants.filter((p) => String(p) !== String(userId));
      notifyUsers.forEach((uid) => io.to(`user:${uid}`).emit("inbox:updated", { conversationId }));
      
      // Utwórz powiadomienia w bazie danych dla użytkowników niebędących w pokoju
      if (notifyUsers.length > 0) {
        try {
          await notifyChatMessage({
            io,
            conversationId,
            messageId: msg._id,
            senderId: userId,
            recipientIds: notifyUsers.map(u => u.toString())
          });
        } catch (error) {
          console.error("Error creating chat notification:", error);
        }
      }

      if (policyNotice) {
        socket.emit("message:policy", {
          conversationId,
          message: policyNotice,
        });
      }
    });

    // Odczyt
    socket.on("message:read", async ({ conversationId, messageIds }) => {
      if (!conversationId) return;
      const filter = { conversation: conversationId };
      if (Array.isArray(messageIds) && messageIds.length) {
        filter._id = { $in: messageIds };
      }
      await Message.updateMany(filter, { $addToSet: { readBy: userId } });
      io.to(`chat:${conversationId}`).emit("message:read", { userId, messageIds: messageIds || null });
    });

    // Typing indicator
    socket.on("typing", ({ conversationId, isTyping }) => {
      if (!conversationId) return;
      socket.to(`chat:${conversationId}`).emit("typing", { conversationId, userId, isTyping: !!isTyping });
    });

    // Reakcje
    socket.on("message:react", async ({ messageId, emoji, action }) => {
      if (!messageId || !emoji) return;
      const msg = await Message.findById(messageId);
      if (!msg) return;
      const inConvo = await Conversation.exists({ _id: msg.conversation, participants: userId });
      if (!inConvo) return;

      if (action === "remove") {
        msg.reactions = msg.reactions.filter(
          (r) => !(String(r.user) === String(userId) && r.emoji === emoji)
        );
      } else {
        msg.reactions.push({ user: userId, emoji });
      }
      await msg.save();
      io.to(`chat:${msg.conversation}`).emit("message:reaction", { messageId, userId, emoji, action: action || "add" });
    });

    // Edycja
    socket.on("message:edit", async ({ messageId, newText }) => {
      const msg = await Message.findById(messageId);
      if (!msg || String(msg.sender) !== String(userId)) return;
      msg.text = newText || "";
      msg.editedAt = new Date();
      await msg.save();
      io.to(`chat:${msg.conversation}`).emit("message:edited", { messageId, newText: msg.text, editedAt: msg.editedAt });
    });

    // Usuwanie (soft)
    socket.on("message:delete", async ({ messageId }) => {
      const msg = await Message.findById(messageId);
      if (!msg || String(msg.sender) !== String(userId)) return;
      msg.deletedAt = new Date();
      msg.text = "";
      msg.attachments = [];
      await msg.save();
      io.to(`chat:${msg.conversation}`).emit("message:deleted", { messageId });
    });

    socket.on("disconnect", () => {
      // opcjonalnie: oznacz status użytkownika
    });
  });
};
