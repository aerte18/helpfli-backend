require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');

(async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
    
    // Znajdź providera
    const provider = await User.findOne({ role: 'provider' });
    if (!provider) {
      console.log('❌ No provider found');
      process.exit(1);
    }
    console.log('✅ Found provider:', provider.email);
    
    // Sprawdź zlecenia
    const query = { status: 'open' };
    console.log('\n🔍 Query:', query);
    
    const orders = await Order.find(query)
      .populate('client', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    console.log(`\n📊 Found ${orders.length} open orders`);
    
    if (orders.length > 0) {
      console.log('\nSample orders:');
      orders.slice(0, 5).forEach((o, i) => {
        console.log(`${i + 1}. Service: "${o.service}", Urgency: ${o.urgency || 'flexible'}, Location: ${o.location || 'N/A'}, Coords: ${o.locationLat ? `${o.locationLat}, ${o.locationLon}` : 'N/A'}`);
      });
    } else {
      console.log('\n⚠️  No open orders found!');
      // Sprawdź wszystkie zlecenia
      const allOrders = await Order.find({}).limit(10).select('status service').lean();
      console.log('\nAll orders (any status):');
      allOrders.forEach(o => {
        console.log(`  - Status: ${o.status}, Service: ${o.service}`);
      });
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
})();

