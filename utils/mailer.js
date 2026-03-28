/**
 * Cienka warstwa nad utils/email.js — ta sama logika co Resend → SMTP.
 * Historycznie wiele modułów importowało mailer (tylko nodemailer); teraz
 * przy RESEND_API_KEY idzie przez Resend, SMTP tylko gdy brak klucza.
 */
const email = require("./email");

async function sendMail(opts) {
  const result = await email.sendMail(opts);
  if (!result.ok) {
    const err = new Error(result.reason || "mail_send_failed");
    err.mailResult = result;
    throw err;
  }
  return result;
}

/** @deprecated Zostawione dla kompatybilności; nie używaj przy wysyłce — użyj sendMail. */
function makeTransport() {
  return null;
}

module.exports = { makeTransport, sendMail };
