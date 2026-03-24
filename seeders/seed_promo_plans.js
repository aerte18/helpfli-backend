require('dotenv').config();
const mongoose = require('mongoose');
const PromotionPlan = require('../models/promotionPlan');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const plans = [
    {
      code: 'HIGHLIGHT_24H',
      name: 'Wyróżnienie 24h',
      description: 'Obwódka fioletowa + podbicie listy przez 24h',
      price: 1000, // 10 zł
      durationDays: 1,
      effects: { highlight: true, topBadge: false, aiBadge: false },
      rankingPointsAdd: 20,
    },
    {
      code: 'TOP_7D',
      name: 'TOP 7 dni',
      description: 'Badge TOP przez 7 dni',
      price: 4900, // 49 zł
      durationDays: 7,
      effects: { highlight: false, topBadge: true, aiBadge: false },
      rankingPointsAdd: 40,
    },
    {
      code: 'TOP_14D',
      name: 'TOP 14 dni',
      description: 'Badge TOP przez 14 dni + AI rekomendacja 7 dni',
      price: 9900, // 99 zł
      durationDays: 14,
      effects: { highlight: false, topBadge: true, aiBadge: true },
      rankingPointsAdd: 60,
    },
    {
      code: 'TOP_31D',
      name: 'TOP 31 dni',
      description: 'Badge TOP + AI rekomendacja + highlight 31 dni',
      price: 19900, // 199 zł
      durationDays: 31,
      effects: { highlight: true, topBadge: true, aiBadge: true },
      rankingPointsAdd: 100,
    },
  ];

  for (const p of plans) {
    await PromotionPlan.updateOne({ code: p.code }, { $set: p }, { upsert: true });
  }
  console.log('Promo plans seeded.');
  await mongoose.disconnect();
  process.exit(0);
})();






















