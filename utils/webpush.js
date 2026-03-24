const webpush = require("web-push");
const User = require("../models/User");
const logger = require("./logger");

// Domyślne klucze VAPID (w produkcji użyj własnych)
const DEFAULT_VAPID_PUBLIC_KEY = "BDlNtEgV-XsDrBc2dKPCXwY3AlUO0g-hm0GvaAE75E-wqa6WR3zw2Ggzdty9DVz3PVcIaDxpGibBhhv_I15Oqs8";
const DEFAULT_VAPID_PRIVATE_KEY = "BvSbleBgyYTddIws1H6-1XHZrzyPXdxVJ4CLCCUNsZw";

let VAPID_PUBLIC_KEY = null;
let VAPID_PRIVATE_KEY = null;
let webpushEnabled = false;

function tryConfigureVapid(publicKey, privateKey, label) {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:support@helpfli.app",
      publicKey,
      privateKey
    );
    VAPID_PUBLIC_KEY = publicKey;
    VAPID_PRIVATE_KEY = privateKey;
    webpushEnabled = true;
    logger?.info?.(`✅ Web-push VAPID skonfigurowany (${label})`);
    return true;
  } catch (e) {
    logger?.warn?.(`⚠️ Web-push VAPID niepoprawny (${label}) - ${e?.message || e}`);
    return false;
  }
}

// Konfiguracja VAPID dla push notifications:
// - jeśli ENV jest ustawiony, spróbuj go użyć
// - jeśli ENV jest niepoprawny, fallback do domyślnych kluczy
// - jeśli nadal nie działa, webpush zostaje wyłączony (bez crasha backendu)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  tryConfigureVapid(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY, "env");
}
if (!webpushEnabled) {
  tryConfigureVapid(DEFAULT_VAPID_PUBLIC_KEY, DEFAULT_VAPID_PRIVATE_KEY, "default");
}
if (!webpushEnabled) {
  logger?.warn?.("⚠️ Web-push wyłączony (brak poprawnych VAPID keys) - backend działa bez push powiadomień");
}

async function saveSubscription(userId, sub) {
  if (!userId || !sub?.endpoint) return;
  await User.updateOne(
    { _id: userId },
    { $addToSet: { pushSubs: { endpoint: sub.endpoint, keys: sub.keys } } }
  );
}

async function sendPushToUser(userId, payload) {
  if (!webpushEnabled) return;
  const user = await User.findById(userId).lean();
  if (!user?.pushSubs?.length) return;
  
  const results = await Promise.allSettled(
    user.pushSubs.map(sub => webpush.sendNotification(sub, JSON.stringify(payload)))
  );
  
  // Usuń nieaktywne subskrypcje
  const failedSubs = results
    .map((result, index) => result.status === 'rejected' ? user.pushSubs[index] : null)
    .filter(Boolean);
    
  if (failedSubs.length > 0) {
    await User.updateOne(
      { _id: userId },
      { $pull: { pushSubs: { endpoint: { $in: failedSubs.map(s => s.endpoint) } } } }
    );
  }
}

module.exports = { saveSubscription, sendPushToUser, VAPID_PUBLIC_KEY };
