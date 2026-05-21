const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { notifyChatMessage } = require("./notifier");

/**
 * Wiadomość z centrum sprawy trafia też do czatu zlecenia — powiadomienie otwiera czat.
 */
async function mirrorDisputeMessageToOrderChat({ order, senderId, text, io }) {
  const clientId = order.client?._id || order.client;
  const providerId = order.provider?._id || order.provider;
  if (!clientId || !providerId) return null;

  let conversation = await Conversation.findOne({ order: order._id });
  if (!conversation) {
    conversation = await Conversation.create({
      order: order._id,
      participants: [clientId, providerId],
    });
  }

  const chatText = `[Sprawa reklamacyjna]\n${String(text).trim()}`;
  const msg = await Message.create({
    conversation: conversation._id,
    sender: senderId,
    text: chatText,
    readBy: [senderId],
  });
  conversation.lastMessage = msg._id;
  conversation.lastMessageAt = msg.createdAt;
  await conversation.save();

  const recipientIds = conversation.participants
    .map((p) => String(p._id || p))
    .filter((id) => id !== String(senderId));

  if (recipientIds.length) {
    await notifyChatMessage({
      io,
      conversationId: conversation._id,
      messageId: msg._id,
      senderId,
      recipientIds,
    });
  }

  if (io) {
    const populated = await Message.findById(msg._id).populate("sender", "name _id");
    io.to(`chat:${conversation._id}`).emit("message:new", { message: populated });
    recipientIds.forEach((uid) => io.to(`user:${uid}`).emit("inbox:updated", { conversationId: conversation._id }));
  }

  return { conversationId: conversation._id, messageId: msg._id };
}

module.exports = { mirrorDisputeMessageToOrderChat };
