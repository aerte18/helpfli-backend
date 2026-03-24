?require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    const hashedPassword = await bcrypt.hash('admin123', 10);
    
    const user = await User.findOneAndUpdate(
      { email: 'admin@helpfli.local' },
      {
        $set: {
          name: 'Admin Helpfli',
          email: 'admin@helpfli.local',
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
    console.log('Hasło: admin123');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Błąd:', error);
    process.exit(1);
  }
})();










