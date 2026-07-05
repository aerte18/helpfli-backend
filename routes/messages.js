const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { authMiddleware } = require("../middleware/authMiddleware");
const Message = require("../models/Message");
const Order = require("../models/Order");
const { userCanAccessOrderSensitive } = require("../utils/orderAccess");
const { chatLimiter, uploadLimiter } = require("../middleware/rateLimiter");

const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + file.fieldname + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_ATTACHMENT_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Niedozwolony typ pliku. Dozwolone: PNG, JPG, WEBP, PDF"), false);
    }
  },
});

async function assertOrderMessageAccess(orderId, user) {
  if (!orderId) return { ok: false, status: 400, message: "Brak orderId" };
  const order = await Order.findById(orderId).select("client provider");
  if (!order) return { ok: false, status: 404, message: "Zlecenie nie znalezione" };
  const allowed = await userCanAccessOrderSensitive(order, user);
  if (!allowed) return { ok: false, status: 403, message: "Brak dostępu do wiadomości tego zlecenia" };
  return { ok: true, order };
}

// Pobierz wszystkie wiadomości dla orderId
router.get("/:orderId", authMiddleware, async (req, res) => {
  try {
    const access = await assertOrderMessageAccess(req.params.orderId, req.user);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    const messages = await Message.find({ orderId: req.params.orderId })
      .sort({ createdAt: 1 })
      .populate("from to", "name");
    res.json(messages);
  } catch {
    res.status(500).json({ message: "Błąd pobierania wiadomości" });
  }
});

// Wyślij wiadomość
router.post("/", authMiddleware, chatLimiter, uploadLimiter, upload.single("attachment"), async (req, res) => {
  try {
    const { orderId, to, text } = req.body;
    const access = await assertOrderMessageAccess(orderId, req.user);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    const filePath = req.file ? "/uploads/" + req.file.filename : null;
    const recipientId = to || (String(access.order.client) === String(req.user._id)
      ? access.order.provider
      : access.order.client);

    const msg = await Message.create({
      from: req.user._id,
      to: recipientId,
      orderId,
      text,
      attachment: filePath,
    });

    res.status(201).json(msg);
  } catch {
    res.status(500).json({ message: "Błąd wysyłania wiadomości" });
  }
});

// Oznacz wiadomości jako przeczytane
router.patch("/:orderId/read", authMiddleware, async (req, res) => {
  try {
    const access = await assertOrderMessageAccess(req.params.orderId, req.user);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    await Message.updateMany(
      { orderId: req.params.orderId, to: req.user._id, read: false },
      { $set: { read: true } }
    );
    res.sendStatus(200);
  } catch {
    res.status(500).json({ message: "Błąd oznaczania jako przeczytane" });
  }
});

// Inbox — wszystkie rozmowy użytkownika
router.get("/", authMiddleware, async (req, res) => {
  try {
    const messages = await Message.aggregate([
      {
        $match: {
          $or: [{ from: req.user._id }, { to: req.user._id }],
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$orderId",
          lastMessage: { $first: "$$ROOT" },
        },
      },
    ]);
    res.json(messages);
  } catch {
    res.status(500).json({ message: "Błąd pobierania inboxu" });
  }
});

// Dodaj reakcję
router.post("/:id/react", authMiddleware, chatLimiter, async (req, res) => {
  try {
    const { type } = req.body;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ message: "Nie znaleziono" });
    const access = await assertOrderMessageAccess(message.orderId, req.user);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    message.reactions.push({ userId: req.user._id, type });
    await message.save();
    res.json(message);
  } catch {
    res.status(500).json({ message: "Błąd dodawania reakcji" });
  }
});

// Edytuj wiadomość
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    const message = await Message.findById(req.params.id);

    if (!message.from.equals(req.user._id)) {
      return res.status(403).json({ message: "Nieautoryzowany" });
    }

    message.text = text;
    message.edited = true;
    await message.save();
    res.json(message);
  } catch {
    res.status(500).json({ message: "Błąd edycji wiadomości" });
  }
});

module.exports = router;
