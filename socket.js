const Conversation = require("./models/Conversation");
const Message = require("./models/Message");
const socketAuth = require("./middleware/socketAuth");
const { notifyChatMessage } = require("./utils/notifier");

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

      const msg = await Message.create({
        conversation: conversationId,
        sender: userId,
        text: text || "",
        attachments: attachments || [],
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
