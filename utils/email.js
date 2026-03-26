const nodemailer = require('nodemailer');
let Resend = null;
try {
  ({ Resend } = require('resend'));
} catch (_) {
  // Resend SDK is optional at runtime; SMTP fallback remains available.
}

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
  // Prefer Resend in production setup.
  if (process.env.RESEND_API_KEY) {
    if (!Resend) return { ok: false, reason: 'resend_sdk_missing' };
    const client = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.EMAIL_FROM || 'Helpfli <noreply@helpfli.pl>';
    const result = await client.emails.send({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    });
    return { ok: true, id: result?.data?.id || result?.id };
  }

  const t = getTransporter();
  if (!t) return { ok:false, reason:'mail_provider_not_configured' };
  const info = await t.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Helpfli <noreply@helpfli.pl>',
    to, subject, html, attachments
  });
  return { ok:true, messageId: info.messageId };
}

module.exports = { sendMail };






















