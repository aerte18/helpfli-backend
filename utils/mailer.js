const nodemailer = require("nodemailer");

function makeTransport() {
  // Ustaw dane w .env:
  // SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendMail({ to, subject, html }) {
  const transporter = makeTransport();
  const from = process.env.SMTP_FROM || "Helpfli <no-reply@helpfli.app>";
  await transporter.sendMail({ from, to, subject, html });
}

module.exports = { makeTransport, sendMail };























