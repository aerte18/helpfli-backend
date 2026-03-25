require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/SubscriptionPlan');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    const businessPlans = await SubscriptionPlan.find({ key: { $regex: /^BUSINESS_/ } });
    console.log(`\nZnaleziono ${businessPlans.length} planów biznesowych w bazie:`);
    
    if (businessPlans.length === 0) {
      console.log('❌ Brak planów biznesowych! Trzeba je zaseedować.');
      console.log('\nUruchom: POST /api/subscriptions/seed');
    } else {
      businessPlans.forEach(p => {
        console.log(`✅ ${p.key}: ${p.name} - ${p.priceMonthly} zł/mies.`);
      });
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
})();







