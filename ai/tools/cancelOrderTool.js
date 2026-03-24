/**
 * Tool: cancelOrder
 * Anuluje zlecenie (tylko klient, tylko status open)
 */

const Order = require('../../models/Order');
const Offer = require('../../models/Offer');

async function cancelOrderTool(params, context) {
  const userId = context.userId;
  if (!userId) {
    throw new Error('Wymagane zalogowanie.');
  }

  const orderId = params.orderId;
  const order = await Order.findById(orderId);
  if (!order) {
    throw new Error('Zlecenie nie istnieje.');
  }
  if (String(order.client) !== String(userId)) {
    throw new Error('Tylko klient może anulować to zlecenie.');
  }
  if (order.status !== 'open') {
    throw new Error(`Nie można anulować zlecenia ze statusem: ${order.status}. Można anulować tylko zlecenia otwarte.`);
  }

  const acceptedOffer = await Offer.findOne({ orderId: order._id, status: 'accepted' });
  if (acceptedOffer) {
    throw new Error('Nie można anulować zlecenia z zaakceptowaną ofertą.');
  }

  order.status = 'cancelled';
  await order.save();
  await Offer.updateMany(
    { orderId: order._id, status: 'submitted' },
    { $set: { status: 'rejected' } }
  );

  return {
    success: true,
    message: 'Zlecenie zostało anulowane.',
    orderId: String(order._id),
  };
}

module.exports = cancelOrderTool;
