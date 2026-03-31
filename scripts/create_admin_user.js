require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    const email = process.env.ADMIN_EMAIL || 'admin@helpfli.local';
    const name = process.env.ADMIN_NAME || 'Admin Helpfli';
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          name,
          email,
          password: hashedPassword,
          role: 'admin',
          emailVerified: true,
          onboardingCompleted: true,
          isActive: true,
          location: 'Warszawa',
          locationCoords: { lat: 52.2297, lng: 21.0122 },
          phone: '+48 123 456 789'
        }
      },
      { upsert: true, new: true }
    );

    console.log('✅ Utworzono/zaktualizowano użytkownika admina:', user.email);
    console.log('Hasło:', password);
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Błąd:', error);
    process.exit(1);
  }
})();










