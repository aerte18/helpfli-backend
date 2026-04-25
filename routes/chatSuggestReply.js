/**
 * POST /api/ai/chat-suggest-reply
 * Zwraca 2–3 sugerowane odpowiedzi dla wykonawcy w czacie z klientem (kontekst: ostatnie wiadomości + zlecenie).
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Order = require('../models/Order');
const Anthropic = require('@anthropic-ai/sdk');

const MAX_MESSAGES = 15;
const MAX_SUGGESTIONS = 3;

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.length < 20) return null;
  return new Anthropic({ apiKey: key });
}

/**
 * Pobiera ostatnie wiadomości konwersacji powiązanej z zleceniem (Conversation.order).
 */
async function getRecentMessagesForOrder(orderId, limit = MAX_MESSAGES) {
  const convo = await Conversation.findOne({ order: orderId }).select('_id').lean();
  if (!convo) return [];
  const msgs = await Message.find({ conversation: convo._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('sender', 'name _id')
    .lean();
  return msgs.reverse();
}

/**
 * Wiadomości z orderId (legacy API messages.js – Message może mieć orderId w innym modelu).
 * Jeśli w projekcie Message nie ma orderId, ta ścieżka nie zwróci nic – wtedy używamy tylko Conversation.
 */
async function getRecentMessagesByOrderId(orderId, limit = MAX_MESSAGES) {
  if (!Message.schema.paths.orderId) return [];
  const msgs = await Message.find({ orderId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('from', 'name _id')
    .lean();
  return msgs.reverse();
}

router.post('/chat-suggest-reply', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId.' });
    }

    const user = req.user;
    const order = await Order.findById(orderId).populate('client provider', 'name _id').lean();
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie istnieje.' });
    }

    const providerId = String(order.provider?._id || order.provider);
    const clientId = String(order.client?._id || order.client);
    const currentUserId = String(user._id || user.id);

    // Tylko wykonawca z tego zlecenia dostaje sugestie (odpowiada klientowi).
    if (currentUserId !== providerId) {
      return res.status(403).json({ message: 'Sugerowane odpowiedzi są dostępne tylko dla wykonawcy tego zlecenia.' });
    }

    let messages = await getRecentMessagesForOrder(orderId);
    if (messages.length === 0) {
      messages = await getRecentMessagesByOrderId(orderId);
    }

    const clientName = order.client?.name || 'Klient';
    const providerName = order.provider?.name || 'Wykonawca';

    const formatMsg = (m) => {
      const isClient = String(m.sender?._id || m.from?._id) === clientId;
      const who = isClient ? clientName : providerName;
      const text = m.text || m.content || '';
      return `${who}: ${text}`;
    };

    const conversationText = messages.map(formatMsg).join('\n') || 'Brak wcześniejszych wiadomości.';

    const client = getClient();
    if (!client) {
      return res.json({
        suggestions: [
          'Dziękuję za wiadomość. Odpowiem wkrótce ze szczegółami.',
          'Potwierdzam odbiór. Wracam z wyceną/terminem.',
          'Proszę o chwilę – sprawdzam dostępność i dam znać.',
        ],
      });
    }

    const system = `Jesteś asystentem dla wykonawcy usług. Generujesz krótkie, profesjonalne i życzliwe propozycje odpowiedzi do klienta w czacie zleceniowym. Odpowiedz wyłącznie w formacie JSON: { "suggestions": ["odpowiedź 1", "odpowiedź 2", "odpowiedź 3"] }. Maksymalnie ${MAX_SUGGESTIONS} propozycje, każda do 2 zdań, po polsku.`;
    const userPrompt = `Kontekst zlecenia: ${(order.description || '').slice(0, 300)}.\n\nOstatnia rozmowa:\n${conversationText}\n\nPodaj ${MAX_SUGGESTIONS} propozycje odpowiedzi, które wykonawca może wysłać do klienta (potwierdzenie terminu, wycena, pytanie o szczegóły, itp.).`;

    const response = await client.messages.create({
      model: process.env.CLAUDE_DEFAULT || 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = response.content?.[0]?.text || '{}';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    let suggestions = [];
    if (start >= 0 && end > start) {
      try {
        const json = JSON.parse(text.slice(start, end));
        suggestions = Array.isArray(json.suggestions) ? json.suggestions.slice(0, MAX_SUGGESTIONS) : [];
      } catch (_) {}
    }
    if (suggestions.length === 0) {
      suggestions = [
        'Dziękuję za wiadomość. Odpowiem wkrótce.',
        'Potwierdzam – wracam z wyceną/terminem.',
        'Proszę o chwilę – sprawdzam i dam znać.',
      ];
    }

    res.json({ suggestions });
  } catch (err) {
    console.error('Chat suggest reply error:', err);
    res.status(500).json({
      message: 'Błąd generowania sugestii.',
      suggestions: [
        'Dziękuję za wiadomość. Odpowiem wkrótce.',
        'Potwierdzam odbiór. Dam znać ze szczegółami.',
      ],
    });
  }
});

module.exports = router;
