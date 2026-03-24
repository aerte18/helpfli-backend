/**
 * Tool: listMyOrders
 * Zwraca listę zleceń klienta (dla Asystenta AI)
 */

const Order = require('../../models/Order');

async function listMyOrdersTool(params, context) {
  const userId = context.userId;
  if (!userId) {
    throw new Error('Wymagane zalogowanie.');
  }

  const limit = Math.min(parseInt(params.limit, 10) || 20, 50);
  const orders = await Order.find({ client: userId })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select('_id status service description createdAt expiresAt')
    .lean();

  const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || '';
  const items = orders.map((o) => ({
    id: String(o._id),
    status: o.status,
    service: typeof o.service === 'object' ? o.service?.name_pl || o.service?.code : o.service,
    description: (o.description || '').substring(0, 80) + (o.description && o.description.length > 80 ? '…' : ''),
    createdAt: o.createdAt,
    link: baseUrl ? `${baseUrl}/orders/${o._id}` : `/orders/${o._id}`,
  }));

  return {
    count: items.length,
    orders: items,
    summary: `Klient ma ${items.length} zleceń. Można przedłużyć tylko zlecenia ze statusem "open" lub "collecting_offers". Anulować można tylko "open".`,
  };
}

module.exports = listMyOrdersTool;
