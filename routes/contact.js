const express = require("express");
const { sendMail } = require("../utils/mailer");

const router = express.Router();

const CONTACT_RECEIVER = "helpfli@outlook.com";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SUBJECT_LABELS = {
  general: "Pytanie ogolne",
  technical: "Problem techniczny",
  billing: "Platnosci i faktury",
  verification: "Weryfikacja konta",
  complaint: "Reklamacja",
  partnership: "Wspolpraca",
};

router.post("/", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const message = String(req.body?.message || "").trim();

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ message: "Uzupelnij wszystkie pola formularza." });
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ message: "Podaj poprawny adres email." });
    }
    if (message.length < 5) {
      return res.status(400).json({ message: "Wiadomosc jest za krotka." });
    }

    const subjectLabel = SUBJECT_LABELS[subject] || subject;
    const mailSubject = `[Kontakt Helpfli] ${subjectLabel}`;
    const html = `
      <h2>Nowa wiadomosc z formularza kontaktowego</h2>
      <p><strong>Imie i nazwisko:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email nadawcy:</strong> ${escapeHtml(email)}</p>
      <p><strong>Temat:</strong> ${escapeHtml(subjectLabel)}</p>
      <p><strong>Wiadomosc:</strong></p>
      <p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>
    `;

    await sendMail({
      to: CONTACT_RECEIVER,
      subject: mailSubject,
      html,
    });

    return res.json({ ok: true, message: "Wiadomosc zostala wyslana." });
  } catch (error) {
    console.error("CONTACT_FORM_SEND_ERROR:", error?.message || error);
    return res.status(500).json({ message: "Nie udalo sie wyslac wiadomosci." });
  }
});

module.exports = router;
