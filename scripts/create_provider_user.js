require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    const hashedPassword = await bcrypt.hash('test123', 10);
    
    const providerEmails = ['provider@quicksy.local', 'provider@helpfli.local'];

    for (const email of providerEmails) {
      const user = await User.findOneAndUpdate(
        { email },
        {
          $set: {
            name: 'Jan Kowalski - Hydraulik',
            email,
            password: hashedPassword,
            role: 'provider',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true,
            location: 'Warszawa',
            locationCoords: { lat: 52.2297, lng: 21.0122 },
            phone: '+48 123 456 789',
            bio: 'Profesjonalny hydraulik z 10-letnim doświadczeniem. Naprawiam krany, instalacje wodne, ogrzewanie. Szybko i rzetelnie!',
            level: 'pro',
            providerLevel: 'pro',
            price: 120,
            time: 2,
            verification: {
              status: 'verified',
              method: 'manual',
              verifiedAt: new Date()
            }
          }
        },
        { upsert: true, new: true }
      );
      console.log('✅ Utworzono/zaktualizowano użytkownika:', user.email);
    }
    console.log('Hasło dla obu kont: test123');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Błąd:', error);
    process.exit(1);
  }
})();













