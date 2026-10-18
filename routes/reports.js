const express = require("express");
const router = express.Router();
const multer = require("multer");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Report = require("../models/Report");
const { reportLimiter } = require('../middleware/rateLimiter');
const {
  safeUploadName,
  removeUploadedFiles,
  validateUploadedFiles,
} = require('../utils/uploadSafety');

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
    try {
      cb(null, safeUploadName('report', file, req.user?._id));
    } catch (error) {
      cb(error);
    }
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'video/mp4', 'video/quicktime', 'video/x-msvideo',
    ]);
    if (allowedTypes.has(String(file.mimetype || '').toLowerCase())) return cb(null, true);
    return cb(new Error('Nieobsługiwany typ pliku. Dozwolone: obrazy, PDF i wideo.'));
  }
});

const toPublicUrl = (filename) => `/uploads/reports/${filename}`;

function runReportUpload(req, res, next) {
  upload.array('attachments', 5)(req, res, (error) => {
    if (!error) return next();
    removeUploadedFiles(req.files);
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Załącznik jest za duży (maksymalnie 10 MB)'
      : error.message || 'Błąd uploadu załącznika';
    return res.status(400).json({ message });
  });
}

router.post("/", auth, reportLimiter, runReportUpload, async (req, res) => {
  try {
    const { reportedUser, reason } = req.body;
    const normalizedReason = String(reason || '').trim();
    if (!mongoose.Types.ObjectId.isValid(reportedUser) || normalizedReason.length < 10 || normalizedReason.length > 2000) {
      // Usuń przesłane pliki jeśli brak danych
      if (req.files) {
        req.files.forEach(file => {
          fs.unlink(file.path, () => {});
        });
      }
      return res.status(400).json({ message: "Podaj prawidłowego użytkownika i powód (10–2000 znaków)" });
    }

    if (String(reportedUser) === String(req.user._id)) {
      removeUploadedFiles(req.files);
      return res.status(400).json({ message: 'Nie możesz zgłosić własnego konta' });
    }

    if (await Report.exists({ user: req.user._id, reportedUser })) {
      removeUploadedFiles(req.files);
      return res.status(409).json({ message: 'To konto zostało już przez Ciebie zgłoszone' });
    }

    if (!(await validateUploadedFiles(req.files))) {
      removeUploadedFiles(req.files);
      return res.status(400).json({ message: 'Zawartość pliku nie odpowiada zadeklarowanemu formatowi' });
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
      reason: normalizedReason,
      attachments 
    });
    
    res.json({ message: "Zgłoszenie przyjęte", attachmentsCount: attachments.length });
  } catch (e) {
    // Usuń przesłane pliki w przypadku błędu
    removeUploadedFiles(req.files);
    console.error('Report error:', e);
    if (e?.code === 11000) {
      return res.status(409).json({ message: 'To konto zostało już przez Ciebie zgłoszone' });
    }
    res.status(500).json({ message: "Błąd serwera" });
  }
});

module.exports = router;
