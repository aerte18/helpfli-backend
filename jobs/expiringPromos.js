const cron = require("node-cron");
const User = require("../models/User");
const { sendPushToUser } = require("../utils/webpush");
const { sendMail } = require("../utils/email");

function leftDays(until) {
  if (!until) return Infinity;
  const ms = new Date(until) - new Date();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

async function notify(user, kind, until) {
  const days = leftDays(until);
  if (days < 0 || days > 3) return; // powiadamiamy 3..0 dni
  
  const to = user.email;
  const subject = `Helpfli: Twój pakiet ${kind} kończy się za ${days} dni`;
  const url = `${process.env.FRONTEND_URL || "http://localhost:5173"}/provider/promote`;
  const html = `
    <p>Cześć ${user.name || ""},</p>
    <p>Twój pakiet <b>${kind}</b> wygaśnie <b>za ${days} dni</b>.</p>
    <p><a href="${url}" target="_blank">Przedłuż teraz</a>, aby utrzymać pozycję w rankingu i oznaczenia TOP/AI.</p>
    <p>Pozdrawiamy,<br/>Zespół Helpfli</p>
  `;
  
  try {
    const result = await sendMail({ to, subject, html });
    if (!result.ok) {
      console.error(`Email error for ${to}:`, result.reason);
    } else {
      console.log(`Email sent to ${to} about ${kind} expiring in ${days} days`);
    }
  } catch (err) {
    console.error(`Email error for ${to}:`, err);
  }
  
  // Push notification
  try {
    await sendPushToUser(user._id, {
      title: `Pakiet ${kind} kończy się`,
      message: `Wygasa za ${days} dni. Przedłuż, aby utrzymać TOP/AI.`,
      url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/provider/promote`
    });
  } catch(e) { 
    console.error("push error", e); 
  }
}

async function runOnce() {
  try {
    const users = await User.find({ 
      role: "provider",
      $or: [
        { "promo.topBadgeUntil": { $exists: true, $ne: null } },
        { "promo.highlightUntil": { $exists: true, $ne: null } },
        { "promo.aiTopTagUntil": { $exists: true, $ne: null } }
      ]
    }).select("name email promo");
    
    console.log(`Checking ${users.length} providers for expiring promos...`);
    
    for (const u of users) {
      const p = u.promo || {};
      // powiadomienia dla najważniejszych flag
      if (p.topBadgeUntil) await notify(u, "TOP", p.topBadgeUntil);
      if (p.highlightUntil) await notify(u, "Wyróżnienie", p.highlightUntil);
      if (p.aiTopTagUntil) await notify(u, "AI poleca", p.aiTopTagUntil);
    }
  } catch (err) {
    console.error("Expiring promos job error:", err);
  }
}

module.exports.start = () => {
  // codziennie o 9:05
  cron.schedule("5 9 * * *", () => runOnce().catch(console.error), { timezone: "Europe/Warsaw" });
  console.log("Expiring promos job scheduled for 9:05 AM daily");
};
