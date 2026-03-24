const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Minimal safe connection cache
let cached = null;
async function connectMongo() {
  if (cached) return cached;
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  cached = await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });
  return cached;
}

// Import User model (schema only)
const User = require('../../models/User');

async function parseJson(req) {
  return await new Promise((resolve, reject) => {
    try {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('INVALID_JSON')); }
      });
    } catch (e) { reject(e); }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405; res.end('Method Not Allowed'); return;
  }
  try {
    await connectMongo();
    const body = await parseJson(req);

    const { email, password } = body || {};
    if (!email || !password) {
      res.statusCode = 400; return res.end(JSON.stringify({ message: 'Podaj email i hasło' }));
    }

    const user = await User.findOne({ email });
    if (!user) { res.statusCode = 400; return res.end(JSON.stringify({ message: 'Nieprawidłowe dane logowania' })); }

    const match = await bcrypt.compare(password, user.password);
    if (!match) { res.statusCode = 400; return res.end(JSON.stringify({ message: 'Nieprawidłowe dane logowania' })); }

    if (!user.emailVerified) {
      res.statusCode = 403; return res.end(JSON.stringify({ message: 'Musisz potwierdzić swój email przed zalogowaniem.', emailNotVerified: true }));
    }

    if (!process.env.JWT_SECRET) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'Błąd konfiguracji serwera' })); }

    await User.findByIdAndUpdate(user._id, { 'provider_status.isOnline': true, 'provider_status.lastSeenAt': new Date() });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const fresh = await User.findById(user._id).select('name email phone role isB2B onboardingCompleted');

    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ token, user: { id: user._id, name: fresh.name, email: fresh.email, phone: fresh.phone, role: fresh.role, isB2B: fresh.isB2B, onboardingCompleted: fresh.onboardingCompleted } }));
  } catch (err) {
    console.error('AUTH_LOGIN_FN_ERROR:', err);
    res.statusCode = 500; return res.end(JSON.stringify({ message: 'Błąd serwera' }));
  }
}




