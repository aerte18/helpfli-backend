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

async function recordDelivery({ to, subject, result, provider }) {
  try {
    const NotificationLog = require('../models/NotificationLog');
    const recipient = (Array.isArray(to) ? to.join(', ') : String(to || '')).slice(0, 500);
    await NotificationLog.create({
      type: 'other',
      channel: 'email',
      status: result?.ok ? 'sent' : 'failed',
      subject: String(subject || '').slice(0, 300),
      recipient,
      sentAt: result?.ok ? new Date() : undefined,
      error: result?.ok ? undefined : String(result?.reason || 'mail_send_failed').slice(0, 1000),
      metadata: {
        provider,
        providerMessageId: result?.id || result?.messageId || null
      }
    });
  } catch (logError) {
    // Brak logu nie może zablokować wiadomości transakcyjnej.
    console.error('[email] delivery log failed:', logError?.message || logError);
  }
}

async function sendMail({ to, subject, html, attachments = [] }) {
  let result;
  let provider = 'none';

  // Prefer Resend when RESEND_API_KEY is set (ignore SMTP_* for sending).
  if (process.env.RESEND_API_KEY) {
    provider = 'resend';
    if (!Resend) {
      result = { ok: false, reason: 'resend_sdk_missing' };
      await recordDelivery({ to, subject, result, provider });
      return result;
    }
    try {
      const client = new Resend(process.env.RESEND_API_KEY);
      const from =
        process.env.EMAIL_FROM || "Helpfli <helpfli@outlook.com>";
      const payload = {
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      };
      if (attachments && attachments.length > 0) {
        payload.attachments = attachments.map((a) => ({
          filename: a.filename || "attachment",
          content: Buffer.isBuffer(a.content)
            ? a.content.toString("base64")
            : typeof a.content === "string"
              ? a.content
              : Buffer.from(a.content || "").toString("base64"),
        }));
      }
      const response = await client.emails.send(payload);
      result = response?.error
        ? { ok: false, reason: response.error.message || 'resend_send_failed' }
        : { ok: true, id: response?.data?.id || response?.id };
    } catch (e) {
      result = {
        ok: false,
        reason: e?.message || "resend_send_failed",
      };
    }
    await recordDelivery({ to, subject, result, provider });
    return result;
  }

  const t = getTransporter();
  provider = 'smtp';
  if (!t) {
    result = { ok: false, reason: 'mail_provider_not_configured' };
    await recordDelivery({ to, subject, result, provider: 'none' });
    return result;
  }
  try {
    const info = await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Helpfli <helpfli@outlook.com>',
      to, subject, html, attachments
    });
    result = { ok: true, messageId: info.messageId };
  } catch (error) {
    result = { ok: false, reason: error?.message || 'smtp_send_failed' };
  }
  await recordDelivery({ to, subject, result, provider });
  return result;
}

module.exports = { sendMail };






















