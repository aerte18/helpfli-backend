/**
 * Job: powiadomienie wykonawców o nowych zleceniach dopasowanych do ich usług.
 * Uruchamiany codziennie (np. o 9:00). Dla każdego providera sprawdza, ile nowych zleceń
 * (z ostatnich 24h) pasuje do niego; jeśli > 0, tworzy powiadomienie in-app.
 */
const cron = require('node-cron');
const User = require('../models/User');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const searchOrdersForProviderTool = require('../ai/tools/searchOrdersForProviderTool');

const HOURS_LOOKBACK = 24;

async function runNewOrdersDigestForProviders() {
  try {
    const since = new Date(Date.now() - HOURS_LOOKBACK * 60 * 60 * 1000);
    const providers = await User.find({
      role: { $in: ['provider', 'company_owner'] },
    })
      .select('_id name services location')
      .lean();

    let notified = 0;
    let skipped = 0;

    for (const provider of providers) {
      try {
        const result = await searchOrdersForProviderTool(
          { sortBy: 'best_match', limit: 30 },
          { userId: provider._id }
        );
        const orders = result?.orders || [];
        if (orders.length === 0) {
          skipped++;
          continue;
        }

        const orderIds = orders.map((o) => o.id).filter(Boolean);
        const newCount = await Order.countDocuments({
          _id: { $in: orderIds },
          status: { $in: ['open', 'collecting_offers'] },
          createdAt: { $gte: since },
        });

        if (newCount === 0) {
          skipped++;
          continue;
        }

        await Notification.create({
          user: provider._id,
          type: 'system_announcement',
          title: 'Nowe zlecenia dla Ciebie',
          message:
            newCount === 1
              ? 'Masz 1 nowe zlecenie dopasowane do Twoich usług.'
              : `Masz ${newCount} nowe zlecenia dopasowane do Twoich usług.`,
          link: '/provider-home',
          metadata: { newOrdersCount: newCount, digestJob: true },
        });
        notified++;
      } catch (err) {
        console.warn(`[newOrdersDigest] Provider ${provider._id}:`, err.message);
      }
    }

    console.log(`[newOrdersDigest] Notified ${notified} providers, skipped ${skipped}.`);
    return { notified, skipped };
  } catch (err) {
    console.error('[newOrdersDigest] Error:', err);
    throw err;
  }
}

function startNewOrdersDigestCron() {
  // Codziennie o 9:00
  cron.schedule('0 9 * * *', async () => {
    await runNewOrdersDigestForProviders();
  });
  console.log('✅ Cron: newOrdersDigestForProviders (0 9 * * *)');
}

module.exports = { runNewOrdersDigestForProviders, startNewOrdersDigestCron };
