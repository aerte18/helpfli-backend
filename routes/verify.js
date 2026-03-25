const express = require("express");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const User = require("../models/User");
const { sendMail } = require("../utils/mailer");
const { tplVerifiedGranted } = require("../utils/emailTemplates");

const router = express.Router();

/**
 * POST /api/verify/mark-verified/:userId
 * body: { method?: "kyc_id"|"company_reg"|"manual" }
 * Wymaga admina; nadaje status verified i badge "verified".
 */
router.post("/mark-verified/:userId", auth, async (req, res) => {
  try {
    if (!req.user?.isAdmin) return res.status(403).json({ message: "Brak uprawnień" });
    const { userId } = req.params;
    const { method = "manual" } = req.body || {};

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "Użytkownik nie istnieje" });

    user.verification = {
      status: "verified",
      method,
      verifiedAt: new Date(),
      reviewer: String(req.user.id),
    };
    user.badges = Array.from(new Set([...(user.badges || []), "verified"]));
    await user.save();

    // Powiadomienie e-mail o przyznaniu Verified
    if (user.email) {
      try {
        await sendMail({
          to: user.email,
          subject: "Helpfli: Twój profil został zweryfikowany",
          html: tplVerifiedGranted({ providerName: user.name || "Wykonawca" }),
        });
      } catch (e) {
        console.error("Email verification error:", e);
      }
    }

    // powiadom fronty live
    const io = req.app.get("io");
    if (io) io.emit("provider:badgeUpdate", { providerId: String(user._id), hasVerified: true });

    res.json({ ok: true, userId: user._id });
  } catch (e) {
    console.error("mark-verified error:", e);
    res.status(500).json({ message: "Błąd oznaczania Verified" });
  }
});

module.exports = router;
