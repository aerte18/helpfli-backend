const ChatMessage = require('../models/ChatMessage');

exports.getHistory = async (roomId) => {
  return await ChatMessage.find({ roomId }).sort({ ts: 1 });
};

exports.save = async (msg) => {
  const saved = new ChatMessage(msg);
  await saved.save();
  return saved;
};

exports.react = async (msgId, userId, emoji) => {
  await ChatMessage.findByIdAndUpdate(msgId, {
    $push: { reactions: { by: userId, emoji } }
  });
};