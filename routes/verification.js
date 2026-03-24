const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Verification = require("../models/Verification");
const VerificationAudit = require("../models/VerificationAudit");

const CODE_TTL_MIN = 10; // 10 minut
const MAX_ATTEMPTS = 3;

// Helper do generowania kodu 6-cyfrowego
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Helper do zapewnienia rekordu weryfikacji
const ensureRecord = async (userId) => {
  let rec = await Verification.findOne({ user: userId });
  if (!rec) {
    rec = new Verification({ user: userId });
    await rec.save();
  }
  return rec;
};

// GET /api/verification/status
router.get("/status", auth, async (req, res) => {
  try {
    const record = await Verification.findOne({ user: req.user._id });
    res.json(record || {});
  } catch (err) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/verification/profile
router.post("/profile", auth, async (req, res) => {
  try {
    const { businessName, taxId, address, website } = req.body;
    const rec = await ensureRecord(req.user._id);
    
    if (businessName) rec.businessName = businessName;
    if (taxId) rec.taxId = taxId;
    if (address) rec.address = address;
    if (website) rec.website = website;
    
    await rec.save();
    await VerificationAudit.create({ user: req.user._id, action: "PROFILE_UPDATED" });
    res.json({ message: "Dane weryfikacyjne zapisane", record: rec });
  } catch (err) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/verification/email/send-code
router.post("/email/send-code", auth, async (req, res) => {
  try {
    const rec = await ensureRecord(req.user._id);
    
    const code = genCode();
    rec.emailCodeHash = await bcrypt.hash(code, 10);
    rec.emailCodeExpiresAt = new Date(Date.now() + CODE_TTL_MIN * 60000);
    rec.emailCodeAttempts = 0;
    await rec.save();
    
    await VerificationAudit.create({ user: req.user._id, action: "EMAIL_CODE_SENT" });
    
    // TODO: wyślij przez email provider (w produkcji użyj SMTP)
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(`[EMAIL VERIFICATION] Send ${code} to ${req.user.email}`);
    }
    res.json({ message: "Kod wysłany na email" });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/verification/email/verify
router.post("/email/verify", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const rec = await ensureRecord(req.user._id);
    
    if (!rec.emailCodeHash || !rec.emailCodeExpiresAt) return res.status(400).json({ message: "Brak aktywnego kodu" });
    if (rec.emailCodeAttempts >= MAX_ATTEMPTS) return res.status(429).json({ message: "Za dużo prób" });
    if (rec.emailCodeExpiresAt < new Date()) return res.status(400).json({ message: "Kod wygasł" });
    
    rec.emailCodeAttempts += 1;
    const ok = await bcrypt.compare(code, rec.emailCodeHash);
    if (!ok) {
      await rec.save();
      return res.status(400).json({ message: "Niepoprawny kod" });
    }
    
    rec.emailVerified = true;
    rec.emailCodeHash = undefined;
    rec.emailCodeExpiresAt = undefined;
    rec.emailCodeAttempts = 0;
    await rec.save();
    
    await VerificationAudit.create({ user: req.user._id, action: "EMAIL_VERIFIED" });
    res.json({ message: "Email zweryfikowany", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/verification/phone/send-code
router.post("/phone/send-code", auth, async (req, res) => {
  try {
    const { phoneNumber } = req.body; // można nadpisać telefon przy wysyłce
    const rec = await ensureRecord(req.user._id);
    if (phoneNumber) rec.phoneNumber = phoneNumber;
    
    const code = genCode();
    rec.phoneCodeHash = await bcrypt.hash(code, 10);
    rec.phoneCodeExpiresAt = new Date(Date.now() + CODE_TTL_MIN * 60000);
    rec.phoneCodeAttempts = 0;
    await rec.save();
    
    await VerificationAudit.create({ user: req.user._id, action: "PHONE_CODE_SENT", meta: { phoneNumber: rec.phoneNumber } });
    
    // TODO: wyślij przez SMS provider (w produkcji użyj providera SMS)
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(`[PHONE VERIFICATION] Send ${code} to ${rec.phoneNumber}`);
    }
    res.json({ message: "Kod wysłany na telefon" });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/verification/phone/verify
router.post("/phone/verify", auth, async (req, res) => {
  try {
    const { code } = req.body;
    const rec = await ensureRecord(req.user._id);
    
    if (!rec.phoneCodeHash || !rec.phoneCodeExpiresAt) return res.status(400).json({ message: "Brak aktywnego kodu" });
    if (rec.phoneCodeAttempts >= MAX_ATTEMPTS) return res.status(429).json({ message: "Za dużo prób" });
    if (rec.phoneCodeExpiresAt < new Date()) return res.status(400).json({ message: "Kod wygasł" });
    
    rec.phoneCodeAttempts += 1;
    const ok = await bcrypt.compare(code, rec.phoneCodeHash);
    if (!ok) {
      await rec.save();
      return res.status(400).json({ message: "Niepoprawny kod" });
    }
    
    rec.phoneVerified = true;
    rec.phoneCodeHash = undefined;
    rec.phoneCodeExpiresAt = undefined;
    rec.phoneCodeAttempts = 0;
    await rec.save();
    
    await VerificationAudit.create({ user: req.user._id, action: "PHONE_VERIFIED" });
    res.json({ message: "Telefon zweryfikowany", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/verification/submit
router.post("/submit", auth, async (req, res) => {
  try {
    const rec = await ensureRecord(req.user._id);
    
    if (!rec.emailVerified) return res.status(400).json({ message: "Najpierw zweryfikuj email" });
    if (!rec.phoneVerified) return res.status(400).json({ message: "Najpierw zweryfikuj telefon" });
    if (!rec.businessName || !rec.taxId) return res.status(400).json({ message: "Uzupełnij dane firmy (nazwa + NIP/REGON)" });
    
    rec.status = "pending_review";
    rec.rejectionReason = undefined;
    await rec.save();
    
    await VerificationAudit.create({ user: req.user._id, action: "SUBMIT" });
    res.json({ message: "Przesłano do weryfikacji", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

module.exports = router;
