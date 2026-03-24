const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { authMiddleware } = require("../middleware/authMiddleware");
const Message = require("../models/Message");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + file.fieldname + ext);
  },
});
const upload = multer({ storage });

// Pobierz wszystkie wiadomości dla orderId
router.get("/:orderId", authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({ orderId: req.params.orderId })
      .sort({ createdAt: 1 })
      .populate("from to", "name");
    res.json(messages);
  } catch {
    res.status(500).json({ message: "Błąd pobierania wiadomości" });
  }
});

// Wyślij wiadomość
router.post("/", authMiddleware, upload.single("attachment"), async (req, res) => {
  try {
    const { orderId, to, text } = req.body;
    const filePath = req.file ? "/uploads/" + req.file.filename : null;

    const msg = await Message.create({
      from: req.user._id,
      to,
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
router.post("/:id/react", authMiddleware, async (req, res) => {
  try {
    const { type } = req.body;
    const message = await Message.findById(req.params.id);
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