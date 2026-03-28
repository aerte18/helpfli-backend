require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const { defaultSubscriptionPlans } = require('../data/defaultSubscriptionPlans');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    await SubscriptionPlan.deleteMany({});
    const created = await SubscriptionPlan.insertMany(defaultSubscriptionPlans);

    console.log(`\n✅ Zaseedowano ${created.length} planów:`);
    created.forEach((p) => {
      console.log(`  - ${p.key}: ${p.name} (${p.priceMonthly} zł/mies.)`);
    });

    const businessPlans = created.filter((p) => p.key.startsWith('BUSINESS_'));
    console.log(`\n📊 Plany biznesowe: ${businessPlans.length}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
})();
