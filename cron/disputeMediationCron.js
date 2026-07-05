const Order = require('../models/Order');
const { notifyAdmins } = require('../utils/adminNotifier');
const { getFrontendUrl } = require('../utils/publicUrl');

/**
 * Po upływie disputeMediationEndsAt: przypomnienie stronom + alert adminowi (bez auto-eskalacji).
 */
async function processExpiredDisputeMediations() {
  const now = new Date();
  const orders = await Order.find({
    disputeMediationEndsAt: { $lte: now },
    disputeEscalatedAt: null,
    disputeStatus: { $in: ['reported', 'refund_requested'] },
    disputeMediationExpiredNotified: { $ne: true },
  })
    .select('_id service disputeStatus disputeMediationEndsAt disputeMessages')
    .limit(50)
    .lean();

  let processed = 0;
  for (const row of orders) {
    const order = await Order.findById(row._id);
    if (!order || order.disputeEscalatedAt) continue;
    if (!order.disputeMediationEndsAt || order.disputeMediationEndsAt > now) continue;
    if (!['reported', 'refund_requested'].includes(order.disputeStatus)) continue;
    if (order.disputeMediationExpiredNotified) continue;

    order.disputeMessages = order.disputeMessages || [];
    order.disputeMessages.push({
      kind: 'system',
      body:
        'Czas mediacji między stronami minął. Jeśli nie doszliście do ugody, możecie przekazać sprawę do zespołu Helpfli (eskalacja) — cel odpowiedzi: 48 h roboczych.',
      createdAt: new Date(),
    });
    order.disputeMediationExpiredNotified = true;
    await order.save();

    await notifyAdmins({
      title: 'Mediacja sporu wygasła',
      body: `Zlecenie ${order.service || order._id}: okno mediacji zakończone — sprawdź, czy wymaga eskalacji.`,
      url: `${getFrontendUrl()}/admin/disputes?tab=open`,
      type: 'dispute_mediation_expired',
      meta: { orderId: String(order._id) },
    });
    processed += 1;
  }
  return { processed };
}

function scheduleDisputeMediationCron(cron) {
  cron.schedule('15 * * * *', async () => {
    try {
      const r = await processExpiredDisputeMediations();
      if (r.processed > 0) {
        console.log(`[CRON] dispute mediation: ${r.processed} order(s) notified`);
      }
    } catch (e) {
      console.error('[CRON] dispute mediation error:', e);
    }
  });
}

module.exports = { processExpiredDisputeMediations, scheduleDisputeMediationCron };
