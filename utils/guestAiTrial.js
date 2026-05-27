const crypto = require('crypto');
const GuestAiUsage = require('../models/GuestAiUsage');

const GUEST_AI_LIMIT = Math.max(1, parseInt(process.env.GUEST_AI_QUERY_LIMIT || '10', 10));
const GUEST_AI_WARN_AT = Math.max(1, parseInt(process.env.GUEST_AI_WARN_AT || '8', 10));
const GUEST_IP_DAILY_CAP = Math.max(GUEST_AI_LIMIT, parseInt(process.env.GUEST_AI_IP_DAILY_CAP || '30', 10));
const REGISTERED_FREE_HINT = parseInt(process.env.CLIENT_FREE_AI_MONTHLY_LIMIT || '50', 10);

const GUEST_ID_RE = /^guest_[a-zA-Z0-9_-]{8,80}$/;

function isValidGuestId(guestId) {
  return typeof guestId === 'string' && GUEST_ID_RE.test(guestId);
}

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.GUEST_AI_IP_SALT || 'quicksy-guest-ai';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function startOfUtcDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function countIpQueriesToday(ipHash) {
  if (!ipHash) return 0;
  const since = startOfUtcDay();
  const rows = await GuestAiUsage.find({ ipHash, updatedAt: { $gte: since } }).select('queryCount').lean();
  return rows.reduce((sum, r) => sum + (r.queryCount || 0), 0);
}

function buildUsagePayload(doc) {
  const used = doc?.queryCount || 0;
  const remaining = Math.max(0, GUEST_AI_LIMIT - used);
  return {
    mode: 'guest',
    limit: GUEST_AI_LIMIT,
    used,
    remaining,
    warnAt: GUEST_AI_WARN_AT,
    showWarning: used >= GUEST_AI_WARN_AT && remaining > 0,
    registeredFreeLimit: REGISTERED_FREE_HINT,
  };
}

async function getGuestUsage(guestId) {
  if (!isValidGuestId(guestId)) {
    return { allowed: false, status: 400, body: { message: 'Nieprawidłowy identyfikator gościa.', code: 'INVALID_GUEST_ID' } };
  }
  const doc = await GuestAiUsage.findOne({ guestId }).lean();
  const usage = buildUsagePayload(doc);
  return {
    allowed: usage.remaining > 0,
    status: usage.remaining > 0 ? 200 : 403,
    usage,
    body: usage.remaining > 0 ? { ok: true, usage } : {
      ok: false,
      code: 'GUEST_AI_LIMIT_EXCEEDED',
      message: `Wykorzystałeś ${GUEST_AI_LIMIT} darmowych zapytań. Załóż konto, aby kontynuować i otrzymać ${REGISTERED_FREE_HINT} zapytań miesięcznie.`,
      usage,
      requiresAuth: true,
      upsell: {
        title: 'Kontynuuj z kontem Helpfli',
        description: `Rejestracja jest darmowa — otrzymasz ${REGISTERED_FREE_HINT} zapytań AI miesięcznie, zapis historii i możliwość utworzenia zlecenia.`,
      },
    },
  };
}

async function checkGuestQuery(guestId, ip) {
  const base = await getGuestUsage(guestId);
  if (!base.allowed) return base;

  const ipHash = hashIp(ip);
  const ipUsedToday = await countIpQueriesToday(ipHash);
  if (ipUsedToday >= GUEST_IP_DAILY_CAP) {
    return {
      allowed: false,
      status: 429,
      usage: base.usage,
      body: {
        code: 'GUEST_AI_RATE_LIMIT',
        message: 'Zbyt wiele zapytań z tej sieci. Spróbuj za chwilę lub załóż konto.',
        requiresAuth: true,
      },
    };
  }

  return base;
}

async function consumeGuestQuery(guestId, ip, sessionId = null) {
  const pre = await checkGuestQuery(guestId, ip);
  if (!pre.allowed) return pre;

  const ipHash = hashIp(ip);
  const update = { $inc: { queryCount: 1 } };
  if (sessionId) update.$set = { lastSessionId: sessionId };

  const doc = await GuestAiUsage.findOneAndUpdate(
    { guestId },
    { ...update, $setOnInsert: { guestId, ipHash } },
    { upsert: true, new: true }
  );

  return { allowed: true, usage: buildUsagePayload(doc) };
}

module.exports = {
  GUEST_AI_LIMIT,
  GUEST_AI_WARN_AT,
  REGISTERED_FREE_HINT,
  isValidGuestId,
  getGuestUsage,
  checkGuestQuery,
  consumeGuestQuery,
};
