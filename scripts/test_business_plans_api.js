require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/SubscriptionPlan');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    // Test filtrowania planów biznesowych (jak w endpoint /api/subscriptions/plans?audience=business)
    const filter = { 
      active: true,
      key: { $regex: /^BUSINESS_/ }
    };
    
    const plans = await SubscriptionPlan.find(filter).sort({ priceMonthly: 1 });
    
    console.log(`\n✅ Endpoint /api/subscriptions/plans?audience=business zwróciłby ${plans.length} planów:`);
    plans.forEach(p => {
      console.log(`  - ${p.key}: ${p.name} - ${p.priceMonthly} zł/mies.`);
      console.log(`    Perks: ${p.perks.slice(0, 3).join(', ')}...`);
    });
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
})();







