const dayjs = require('dayjs');
const Boost = require('../models/Boost');

const BOOSTS = [
  { code: 'TOP_24H', title: 'Wyróżnienie 24h', pricePLN: 9.99, durationDays: 1 },
  { code: 'TOP_7D', title: 'TOP 7 dni', pricePLN: 49, durationDays: 7 },
  { code: 'TOP_30D', title: 'TOP 30 dni', pricePLN: 199, durationDays: 30 },
  { code: 'FAST_TRACK', title: 'Fast-Track (pojedynczy)', pricePLN: 4.99, durationDays: 0 },
  { code: 'HIGHLIGHT', title: 'Wyróżnienie (obwódka fioletowa)', pricePLN: 29, durationDays: 7 },
  { code: 'FEATURED', title: 'Featured (na górze wyników)', pricePLN: 79, durationDays: 7 },
  { code: 'AI_RECOMMENDED', title: 'Polecane przez AI', pricePLN: 99, durationDays: 30 },
  { code: 'VERIFIED_BADGE', title: 'Szybka weryfikacja', pricePLN: 49, durationDays: 0 },
];

const BOOST_BY_CODE = Object.fromEntries(BOOSTS.map((b) => [b.code, b]));

function calculateBulkDiscount(quantity) {
  if (quantity >= 10) return 30;
  if (quantity >= 5) return 20;
  if (quantity >= 3) return 10;
  return 0;
}

async function activateBoostItems(userId, codes, options = {}) {
  const items = codes.map((code) => BOOST_BY_CODE[code]).filter(Boolean);
  if (items.length !== codes.length) {
    throw new Error('Nieprawidłowe kody boostów');
  }
  const startsAt = dayjs(options.startsAt || undefined);
  const created = [];
  for (const [itemIndex, item] of items.entries()) {
    const endsAt = item.durationDays > 0 ? startsAt.add(item.durationDays, 'day') : null;
    const boost = options.stripePaymentIntentId
      ? await Boost.findOneAndUpdate(
          {
            stripePaymentIntentId: options.stripePaymentIntentId,
            stripeItemIndex: itemIndex,
          },
          {
            $setOnInsert: {
              user: userId,
              code: item.code,
              title: item.title,
              startsAt: startsAt.toDate(),
              endsAt: endsAt ? endsAt.toDate() : null,
              stripePaymentIntentId: options.stripePaymentIntentId,
              stripeItemIndex: itemIndex,
            },
          },
          { upsert: true, new: true }
        )
      : await Boost.create({
          user: userId,
          code: item.code,
          title: item.title,
          startsAt: startsAt.toDate(),
          endsAt: endsAt ? endsAt.toDate() : null,
        });
    created.push(boost);
  }
  return created;
}

async function fulfillBoostPaymentFromWebhook(intent, payment) {
  const md = intent.metadata || {};
  if (md.type !== 'boost_purchase') return false;
  if (payment?.status === 'succeeded' && payment.metadata?.boostsFulfilled) return true;

  const userId = md.userId || payment?.provider;
  const codes = md.boostCodes
    ? String(md.boostCodes).split(',').filter(Boolean)
    : md.boostCode
      ? [md.boostCode]
      : [];
  if (!userId || !codes.length) return false;

  const startsAt = Number(intent.created) > 0
    ? new Date(Number(intent.created) * 1000)
    : new Date();
  await activateBoostItems(userId, codes, {
    stripePaymentIntentId: intent.id,
    startsAt,
  });
  if (payment) {
    payment.status = 'succeeded';
    payment.method = intent.payment_method_types?.[0] || payment.method;
    payment.metadata = { ...(payment.metadata || {}), boostsFulfilled: true };
    await payment.save();
  }
  return true;
}

module.exports = {
  BOOSTS,
  BOOST_BY_CODE,
  calculateBulkDiscount,
  activateBoostItems,
  fulfillBoostPaymentFromWebhook,
};
