const dayjs = require('dayjs');
const Payment = require('../models/Payment');
const ProviderSettlement = require('../models/ProviderSettlement');
const User = require('../models/User');

// Automatyczne generowanie miesięcznych rozliczeń dla wszystkich providerów
async function generateMonthlySettlements() {
  const now = dayjs();
  const periodTo = now.startOf('month').subtract(1, 'day'); // ostatni dzień poprzedniego miesiąca
  const periodFrom = periodTo.startOf('month');

  const start = periodFrom.toDate();
  const end = periodTo.endOf('day').toDate();

  console.log(
    '[ProviderSettlements] Generating settlements for period',
    periodFrom.format('YYYY-MM-DD'),
    '–',
    periodTo.format('YYYY-MM-DD')
  );

  // Zgrupuj płatności po providerze
  const aggregates = await Payment.aggregate([
    {
      $match: {
        provider: { $ne: null },
        status: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: '$provider',
        totalRevenue: { $sum: '$amount' },
        platformFees: { $sum: '$platformFeeAmount' },
        paymentIds: { $push: '$_id' },
        paymentCount: { $sum: 1 },
        currency: { $first: '$currency' }
      }
    }
  ]);

  if (!aggregates.length) {
    console.log('[ProviderSettlements] No payments in previous month – nothing to do');
    return;
  }

  let created = 0;

  for (const agg of aggregates) {
    const providerId = agg._id;

    const exists = await ProviderSettlement.findOne({
      provider: providerId,
      periodFrom: start,
      periodTo: end
    });
    if (exists) continue;

    const totalRevenue = agg.totalRevenue || 0;
    const platformFees = agg.platformFees || 0;
    const netRevenue = totalRevenue - platformFees;

    const settlement = await ProviderSettlement.create({
      provider: providerId,
      periodFrom: start,
      periodTo: end,
      totalRevenue,
      platformFees,
      netRevenue,
      currency: (agg.currency || 'pln').toUpperCase(),
      paymentCount: agg.paymentCount || 0,
      paymentIds: agg.paymentIds || [],
      selfBillingStatus: 'none'
    });
    created += 1;

    // Uwaga: Generowanie faktur zostało usunięte - faktury są teraz wystawiane przez KSeF
    // Providerzy mogą pobierać rozliczenia (settlements) do własnych celów księgowych
  }

  console.log(
    `[ProviderSettlements] Created ${created} monthly settlements for period ${periodFrom.format(
      'YYYY-MM-DD'
    )} – ${periodTo.format('YYYY-MM-DD')}`
  );
}

module.exports = {
  generateMonthlySettlements
};


