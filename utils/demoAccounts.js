/**
 * Konta tworzone skryptami seed (np. seed_demo_users.js, seed_sample_orders.js).
 * Dla zwykłych użytkowników nie pokazujemy ich zleceń ani ofert w produkcji.
 */

const DEMO_EMAIL_REGEX = /@(helpfli\.test|quicksy\.local|helpfli\.local)$/i;

function isDemoAccountEmail(email) {
  if (!email || typeof email !== "string") return false;
  return DEMO_EMAIL_REGEX.test(email.trim());
}

/**
 * Czy stosować ukrywanie (true = filtruj demo przed innymi użytkownikami).
 * Wyłączenie: HIDE_DEMO_DATA=0
 * Obejście: zalogowany użytkownik z adresem demo — widzi pełne dane testowe.
 */
function shouldFilterDemoData(viewerUser) {
  if (process.env.HIDE_DEMO_DATA === "0") return false;
  if (viewerUser && isDemoAccountEmail(viewerUser.email)) return false;
  return true;
}

let cachedIds = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

/**
 * ObjectId użytkowników z adresami demo (cache krótki).
 */
async function getDemoUserIds() {
  const now = Date.now();
  if (cachedIds && now - cacheAt < CACHE_TTL_MS) return cachedIds;
  const User = require("../models/User");
  const rows = await User.find({ email: DEMO_EMAIL_REGEX })
    .select("_id")
    .lean();
  cachedIds = rows.map((r) => r._id);
  cacheAt = now;
  return cachedIds;
}

function invalidateDemoUserIdCache() {
  cachedIds = null;
  cacheAt = 0;
}

module.exports = {
  DEMO_EMAIL_REGEX,
  isDemoAccountEmail,
  shouldFilterDemoData,
  getDemoUserIds,
  invalidateDemoUserIdCache,
};
