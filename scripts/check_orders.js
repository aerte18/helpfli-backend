require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');

(async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
    
    const orders = await Order.find({ status: 'open' })
      .select('service description location status urgency locationLat locationLon')
      .lean();
    
    console.log(`\n📊 Total open orders: ${orders.length}\n`);
    console.log('Sample orders:');
    orders.slice(0, 10).forEach((o, i) => {
      console.log(`${i + 1}. Service: "${o.service}", Urgency: ${o.urgency || 'flexible'}, Location: ${o.location || 'N/A'}, Coords: ${o.locationLat ? `${o.locationLat}, ${o.locationLon}` : 'N/A'}`);
    });
    
    // Sprawdź unikalne wartości service
    const uniqueServices = [...new Set(orders.map(o => o.service))];
    console.log(`\n📋 Unique service values (${uniqueServices.length}):`);
    uniqueServices.forEach(s => console.log(`  - "${s}"`));
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
})();

