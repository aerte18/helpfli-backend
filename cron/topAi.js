const cron = require("node-cron");
const User = require("../models/User");
const { recomputeTopAiBadge } = require("../utils/topAiBadge");

function scheduleTopAiCron(io) {
  // Każdego dnia o 03:30
  cron.schedule("30 3 * * *", async () => {
    try {
      const providers = await User.find({ role: "provider" }, { _id:1 }).lean();
      for (const p of providers) {
        const r = await recomputeTopAiBadge(p._id);
        // powiadom w razie zmiany (opcjonalnie)
        if (r.updated && io) {
          io.emit("provider:badgeUpdate", { providerId: String(p._id), hasTopAi: r.hasBadge });
        }
      }
      console.log("[CRON] TOP AI recomputed");
    } catch (e) {
      console.error("[CRON] TOP AI error:", e);
    }
  });
}

module.exports = { scheduleTopAiCron };
