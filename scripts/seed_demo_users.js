require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });

  const users = [
    { name: 'Jan Provider', email: 'jan@helpfli.test', password: 'Test1234!', role: 'provider', emailVerified: true },
    { name: 'Ewa Provider', email: 'ewa@helpfli.test', password: 'Test1234!', role: 'provider', emailVerified: true },
    { name: 'Client Demo', email: 'client@helpfli.test', password: 'Test1234!', role: 'client', emailVerified: true },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await User.updateOne(
      { email: u.email },
      { $set: { name: u.name, email: u.email, password: hash, role: u.role, emailVerified: true, isActive: true } },
      { upsert: true }
    );
    console.log('✅ upserted', u.email);
  }

  await mongoose.disconnect();
  console.log('Done. You can login with Test1234!');
}

main().catch((e) => { console.error(e); process.exit(1); });





