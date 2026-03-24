const Conversation = require('../models/Conversation');
const ChatMessage = require('../models/ChatMessage');

module.exports = (io, socket) => {
  console.log('Nowe połączenie:', socket.id);

  socket.on('join', (userId) => {
    socket.userId = userId;
    socket.join(userId); // do powiadomień
  });

  // Obsługa pokojów dla ofert
  socket.on('joinOrderRoom', (orderId) => {
    if (orderId) {
      socket.join(`order:${orderId}`);
      console.log(`Socket ${socket.id} dołączył do pokoju order:${orderId}`);
    }
  });

  socket.on('leaveOrderRoom', (orderId) => {
    if (orderId) {
      socket.leave(`order:${orderId}`);
      console.log(`Socket ${socket.id} opuścił pokój order:${orderId}`);
    }
  });

  socket.on('join-conversation', (convId) => {
    socket.join(convId);
  });

  socket.on('typing', ({ convId, from }) => {
    socket.to(convId).emit('typing', { from });
  });

  socket.on('send-message', async ({ convId, from, to, text }) => {
    try {
      const msg = await ChatMessage.create({
        conversation: convId,
        from,
        to,
        text,
        readBy: [from]
      });

      // Aktualizacja konwersacji
      const conv = await Conversation.findById(convId);
      if (conv) {
        const unread = conv.unreadCount.get(to) || 0;
        conv.unreadCount.set(to, unread + 1);
        conv.lastMessage = text;
        conv.lastSender = from;
        await conv.save();
      }

      io.to(convId).emit('new-message', msg);
      to.forEach(uid => io.to(uid).emit('notify', { convId }));
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Połączenie zakończone:', socket.id);
  });
};