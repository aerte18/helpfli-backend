// node scripts/migrate_pack2_users_orders.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    console.log('Migrating Users...');
    // USERS
    const r1 = await User.updateMany({ role: { $exists: false } }, { $set: { role: 'client' } });
    const r2 = await User.updateMany({ rankingPoints: { $exists: false } }, { $set: { rankingPoints: 0 } });
    
    // Sprawdź czy badges to tablica (stary format) czy obiekt (nowy format)
    const r3a = await User.updateMany(
      { badges: { $type: 'array' } }, 
      { $set: { 
        badges: { 
          topUntil: null, 
          aiRecommendedUntil: null, 
          pro: false 
        } 
      }}
    );
    const r3b = await User.updateMany(
      { badges: { $type: 'object' }, 'badges.pro': { $exists: false } }, 
      { $set: { 'badges.pro': false } }
    );
    
    const r4 = await User.updateMany({ kycStatus: { $exists: false } }, { $set: { kycStatus: 'unverified' } });
    const r5 = await User.updateMany({ ratingAvg: { $exists: false } }, { $set: { ratingAvg: 0 } });

    console.log('Users patched:', { 
      role: r1.modifiedCount, 
      rankingPoints: r2.modifiedCount, 
      badgesArrayToObject: r3a.modifiedCount,
      badgesPro: r3b.modifiedCount, 
      kycStatus: r4.modifiedCount,
      ratingAvg: r5.modifiedCount
    });

    console.log('Migrating Orders...');
    // ORDERS
    const o1 = await Order.updateMany({ 'payment.protected': { $exists: false } }, { $set: { 'payment.protected': false } });
    const o2 = await Order.updateMany({ 'payment.status': { $exists: false } }, { $set: { 'payment.status': 'requires_payment' } });
    const o3 = await Order.updateMany({ priceTotal: { $exists: false } }, { $set: { priceTotal: 0 } });

    console.log('Orders patched:', { 
      paymentProtected: o1.modifiedCount, 
      paymentStatus: o2.modifiedCount, 
      priceTotal: o3.modifiedCount 
    });

    await mongoose.disconnect();
    console.log('Migration completed successfully!');
  } catch (e) {
    console.error('Migration error:', e);
    process.exit(1);
  }
})();
