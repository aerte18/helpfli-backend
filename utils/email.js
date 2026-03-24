const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? {
      user: process.env.SMTP_USER, pass: process.env.SMTP_PASS
    } : undefined,
  });
  return transporter;
}

async function sendMail({ to, subject, html, attachments=[] }) {
  const t = getTransporter();
  if (!t) return { ok:false, reason:'smtp_not_configured' };
  const info = await t.sendMail({
    from: process.env.VAPID_SUBJECT || 'no-reply@helpfli',
    to, subject, html, attachments
  });
  return { ok:true, messageId: info.messageId };
}

module.exports = { sendMail };






















