const express = require("express");
const router = express.Router();
const { authMiddleware: auth } = require("../../middleware/authMiddleware");
const { isAdmin } = require("../../middleware/roles");
const Verification = require("../../models/Verification");
const VerificationAudit = require("../../models/VerificationAudit");
const User = require("../../models/User");

// GET /api/admin/verifications
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    
    const items = await Verification.find(filter)
      .populate("user", "name email")
      .populate("reviewedBy", "name")
      .sort({ createdAt: -1 });
    
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/admin/verifications/:id/approve
router.post("/:id/approve", auth, isAdmin, async (req, res) => {
  try {
    const rec = await Verification.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: "Nie znaleziono" });
    
    rec.status = "verified";
    rec.verifiedAt = new Date();
    rec.reviewedBy = req.user._id;
    rec.rejectionReason = undefined;
    await rec.save();
    
    await VerificationAudit.create({ user: rec.user, actor: req.user._id, action: "APPROVE" });
    res.json({ message: "Zweryfikowano", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/admin/verifications/:id/reject
router.post("/:id/reject", auth, isAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const rec = await Verification.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: "Nie znaleziono" });
    
    rec.status = "rejected";
    rec.reviewedBy = req.user._id;
    rec.rejectionReason = reason || "";
    await rec.save();
    
    await VerificationAudit.create({ user: rec.user, actor: req.user._id, action: "REJECT", meta: { reason } });
    res.json({ message: "Odrzucono", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/admin/verifications/:id/suspend
router.post("/:id/suspend", auth, isAdmin, async (req, res) => {
  try {
    const rec = await Verification.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: "Nie znaleziono" });
    
    rec.status = "suspended";
    rec.reviewedBy = req.user._id;
    await rec.save();
    
    await VerificationAudit.create({ user: rec.user, actor: req.user._id, action: "SUSPEND" });
    res.json({ message: "Zawieszono", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/admin/verifications/:id/unsuspend
router.post("/:id/unsuspend", auth, isAdmin, async (req, res) => {
  try {
    const rec = await Verification.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: "Nie znaleziono" });
    
    rec.status = "unverified"; // lub "pending_review" jeśli chcesz powrotu do kolejki
    rec.reviewedBy = req.user._id;
    await rec.save();
    
    await VerificationAudit.create({ user: rec.user, actor: req.user._id, action: "UNSUSPEND" });
    res.json({ message: "Odwieszono", record: rec });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// POST /api/admin/verifications/:id/note
router.post("/:id/note", auth, isAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    const rec = await Verification.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: "Nie znaleziono" });
    
    await VerificationAudit.create({ user: rec.user, actor: req.user._id, action: "NOTE", meta: { note } });
    res.json({ message: "Dodano notatkę" });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

module.exports = router;
