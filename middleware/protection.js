// Używaj na endpointach, które mają przysługiwać tylko zleceniom opłaconych w systemie (np. spory, gwarancja, szybkie zwroty)
module.exports.requireProtectedOrder = (req, res, next) => {
  const order = req.order || req.loadedOrder;
  if (!order) return res.status(400).json({ message: 'Order not loaded' });

  const eligible = order.paidInSystem === true && order.paymentStatus === 'succeeded' && order.protectionStatus === 'active';
  if (!eligible) {
    return res.status(403).json({
      message: 'Funkcja dostępna tylko dla zleceń opłaconych w systemie (Gwarancja Helpfli).'
    });
  }
  next();
};






















