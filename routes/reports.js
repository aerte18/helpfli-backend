const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Report = require("../models/Report");
const Verification = require("../models/Verification");
const VerificationAudit = require("../models/VerificationAudit");

const ABUSE_THRESHOLD = 3; // po tylu zgłoszeniach – zawieszenie

// Konfiguracja multer dla uploadu załączników do zgłoszeń
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'reports');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    // Dozwolone typy plików: obrazy, PDF, dokumenty
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|mp4|mov|avi/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Nieobsługiwany typ pliku. Dozwolone: obrazy, PDF, dokumenty, wideo.'));
    }
  }
});

const toPublicUrl = (filename) => `/uploads/reports/${filename}`;

router.post("/", auth, upload.array('attachments', 5), async (req, res) => {
  try {
    const { reportedUser, reason } = req.body;
    if (!reportedUser || !reason) {
      // Usuń przesłane pliki jeśli brak danych
      if (req.files) {
        req.files.forEach(file => {
          fs.unlink(file.path, () => {});
        });
      }
      return res.status(400).json({ message: "Brak danych zgłoszenia" });
    }
    
    // Przygotuj załączniki
    const attachments = (req.files || []).map(file => ({
      filename: file.originalname,
      url: toPublicUrl(file.filename),
      mimetype: file.mimetype,
      size: file.size,
      uploadedAt: new Date()
    }));
    
    await Report.create({ 
      user: req.user._id, 
      reportedUser, 
      reason,
      attachments 
    });
    
    const count = await Report.countDocuments({ reportedUser });
    if (count >= ABUSE_THRESHOLD) {
      const v = await Verification.findOne({ user: reportedUser });
      if (v && v.status !== "suspended") {
        v.status = "suspended";
        await v.save();
        await VerificationAudit.create({ user: reportedUser, actor: req.user._id, action: "SUSPEND", meta: { reason: `Auto przez raporty: ${count}` } });
      }
    }
    
    res.json({ message: "Zgłoszenie przyjęte", attachmentsCount: attachments.length });
  } catch (e) {
    // Usuń przesłane pliki w przypadku błędu
    if (req.files) {
      req.files.forEach(file => {
        fs.unlink(file.path, () => {});
      });
    }
    console.error('Report error:', e);
    res.status(500).json({ message: e.message || "Błąd serwera" });
  }
});

module.exports = router;
