// models/ChatMessage.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ReactionSchema = new Schema({
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  emoji: String
}, { _id: false });

const ChatMessageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    to: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }], // grupy też
    text: { type: String, default: '' },
    attachments: [{
      name: String,
      url: String,
      type: String,
      size: Number
    }],
    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    reactions: [ReactionSchema],
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }
  },
  { timestamps: true }
);

ChatMessageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);