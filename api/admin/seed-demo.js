const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../../models/User');

let cached = null;
async function connectMongo() {
  if (cached) return cached;
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  cached = await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });
  return cached;
}

module.exports = async function handler(req, res) {
  try {
    const key = (new URL(req.url, 'http://x')).searchParams.get('key') || '';
    const allowed = process.env.SEED_KEY || 'demo';
    if (key !== allowed) {
      res.statusCode = 403; return res.end('Forbidden');
    }
    await connectMongo();
    const email = 'demo@helpfli.app';
    const password = await bcrypt.hash('Helpfli!123', 10);
    const doc = {
      name: 'Demo User',
      email,
      password,
      role: 'client',
      emailVerified: true,
      onboardingCompleted: true,
      phone: '000000000',
    };
    await User.updateOne({ email }, { $set: doc }, { upsert: true });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    console.error('SEED_ERROR:', e);
    res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}




