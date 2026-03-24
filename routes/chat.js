const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const { getUserFromToken } = require("../middleware/authMiddleware");

// Multer storage
const uploadDir = path.join(__dirname, "..", "uploads", "chat");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({ storage });

// Helper – auth user id
const requireUser = (req, res, next) => {
  const uid = getUserFromToken(req);
  if (!uid) return res.status(401).json({ message: "Unauthorized" });
  req.userId = uid;
  next();
};

// GET: lista konwersacji użytkownika
router.get("/conversations", requireUser, async (req, res) => {
  const convos = await Conversation.find({ participants: req.userId })
    .populate("participants", "name _id")
    .populate({ path: "lastMessage", populate: { path: "sender", select: "name _id" } })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .lean();

  // policz unread (prosty sposób: wiadomości bez readBy = user)
  const convoIds = convos.map((c) => c._id);
  const unreadAgg = await Message.aggregate([
    { $match: { conversation: { $in: convoIds }, readBy: { $ne: req.userId } } },
    { $group: { _id: "$conversation", count: { $sum: 1 } } },
  ]);
  const unreadMap = Object.fromEntries(unreadAgg.map((u) => [String(u._id), u.count]));

  const data = convos.map((c) => ({ ...c, unreadCount: unreadMap[String(c._id)] || 0 }));
  res.json(data);
});

// POST: utworzenie konwersacji (np. dla zlecenia lub prywatna)
router.post("/conversations", requireUser, async (req, res) => {
  const { participantIds, title, orderId, isGroup } = req.body;
  if (!Array.isArray(participantIds) || !participantIds.length) {
    return res.status(400).json({ message: "participants required" });
  }
  const all = Array.from(new Set([req.userId, ...participantIds]));
  const convo = await Conversation.create({
    title: title || null,
    isGroup: !!isGroup,
    participants: all,
    order: orderId || null,
  });
  res.status(201).json(convo);
});

// GET: wiadomości konwersacji (z paginacją)
router.get("/:conversationId/messages", requireUser, async (req, res) => {
  const { conversationId } = req.params;
  const { before, limit = 50 } = req.query;

  const convo = await Conversation.findById(conversationId);
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  if (!convo.participants.map(String).includes(String(req.userId))) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const filter = { conversation: conversationId };
  if (before) filter.createdAt = { $lt: new Date(before) };

  const msgs = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .populate("sender", "name _id")
    .lean();

  res.json(msgs.reverse());
});

// POST: oznacz wszystko jako przeczytane
router.post("/:conversationId/mark-read", requireUser, async (req, res) => {
  const { conversationId } = req.params;
  const convo = await Conversation.findById(conversationId);
  if (!convo) return res.status(404).json({ message: "Conversation not found" });
  if (!convo.participants.map(String).includes(String(req.userId))) {
    return res.status(403).json({ message: "Forbidden" });
  }
  await Message.updateMany({ conversation: conversationId }, { $addToSet: { readBy: req.userId } });
  res.json({ ok: true });
});

// POST: upload załączników (zwraca metadane do socket `message:send`)
router.post("/upload", requireUser, upload.array("files", 10), async (req, res) => {
  const files = (req.files || []).map((f) => ({
    url: `/uploads/chat/${f.filename}`,
    name: f.originalname,
    size: f.size,
    type: f.mimetype,
  }));
  res.status(201).json({ files });
});

// GET: całkowita liczba nieprzeczytanych wiadomości
router.get("/unread/count", requireUser, async (req, res) => {
  const convos = await Conversation.find({ participants: req.userId }).select("_id");
  const convoIds = convos.map((c) => c._id);
  
  const total = await Message.countDocuments({
    conversation: { $in: convoIds },
    readBy: { $ne: req.userId }
  });
  
  res.json({ total });
});

// POST: prefill wiadomości dla zlecenia (używane przez AI)
router.post("/:orderId/messages/prefill", requireUser, async (req, res) => {
  try {
    const Order = require("../models/Order");
    
    // Znajdź zlecenie
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ message: "Zlecenie nie istnieje" });
    }
    
    // Sprawdź czy użytkownik to klient zlecenia
    if (String(order.client) !== String(req.userId)) {
      return res.status(403).json({ message: "Brak uprawnień" });
    }
    
    // Znajdź lub utwórz konwersację
    let conversation = await Conversation.findOne({
      order: req.params.orderId
    });
    
    if (!conversation) {
      conversation = await Conversation.create({
        order: req.params.orderId,
        participants: [order.client, order.provider].filter(Boolean),
        type: 'order'
      });
    }
    
    // Sprawdź czy już istnieje wiadomość prefill
    const existingPrefill = await Message.findOne({
      conversation: conversation._id,
      type: 'prefill'
    });
    
    if (existingPrefill) {
      return res.json({ 
        ok: true, 
        messageId: existingPrefill._id,
        conversationId: conversation._id 
      });
    }
    
    // Utwórz wiadomość prefill
    let content = `Cześć! To szczegóły mojego zlecenia:\n\n${order.description || ''}`;
    
    if (order.attachments && order.attachments.length > 0) {
      content += `\n\nZałączniki (${order.attachments.length}):`;
      order.attachments.forEach((att, i) => {
        content += `\n${i + 1}. ${att.filename || 'Załącznik'}`;
      });
    }
    
    const message = await Message.create({
      conversation: conversation._id,
      sender: req.userId,
      content: content,
      type: 'prefill',
      attachments: order.attachments || [],
      readBy: [req.userId]
    });
    
    res.json({ 
      ok: true, 
      messageId: message._id,
      conversationId: conversation._id 
    });
    
  } catch (error) {
    console.error("Prefill message error:", error);
    res.status(500).json({ message: "Błąd tworzenia wiadomości prefill" });
  }
});

module.exports = router;