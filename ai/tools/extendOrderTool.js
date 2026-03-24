/**
 * Tool: extendOrder
 * Przedłuża czas zlecenia (tylko klient, tylko open/collecting_offers)
 */

const Order = require('../../models/Order');

async function extendOrderTool(params, context) {
  const userId = context.userId;
  if (!userId) {
    throw new Error('Wymagane zalogowanie.');
  }

  const orderId = params.orderId;
  const hours = Math.min(Math.max(parseInt(params.hours, 10) || 24, 1), 168); // 1–168 (7 dni)

  const order = await Order.findById(orderId);
  if (!order) {
    throw new Error('Zlecenie nie istnieje.');
  }
  if (String(order.client) !== String(userId)) {
    throw new Error('Tylko klient może przedłużyć to zlecenie.');
  }
  if (order.status !== 'open' && order.status !== 'collecting_offers') {
    throw new Error(`Nie można przedłużyć zlecenia ze statusem: ${order.status}. Tylko zlecenia otwarte lub zbierające oferty.`);
  }

  const now = new Date();
  const currentExpiresAt = order.expiresAt || now;
  const newExpiresAt =
    currentExpiresAt < now
      ? new Date(now.getTime() + hours * 60 * 60 * 1000)
      : new Date(currentExpiresAt.getTime() + hours * 60 * 60 * 1000);

  order.expiresAt = newExpiresAt;
  order.extendedCount = (order.extendedCount || 0) + 1;
  order.lastExtendedAt = now;
  order.extensionReason = params.reason || 'Wydłużone przez klienta (Asystent AI)';
  order.autoExtended = false;
  await order.save();

  return {
    success: true,
    message: `Zlecenie zostało przedłużone o ${hours} godzin. Nowy termin wygaśnięcia: ${newExpiresAt.toLocaleString('pl-PL')}.`,
    orderId: String(order._id),
    newExpiresAt: order.expiresAt,
  };
}

module.exports = extendOrderTool;
