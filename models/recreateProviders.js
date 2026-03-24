const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const User = require('./User');

dotenv.config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(async () => {
    console.log('Połączono z MongoDB');

    // Delete all existing providers
    await User.deleteMany({ role: 'provider' });
    console.log('Usunięto istniejących dostawców');

    // Lista przykładowych dostawców usług z pełnymi danymi
    const providers = [
      {
        name: 'Jan Kowalski',
        email: 'jan.kowalski@example.com',
        password: 'password123',
        role: 'provider',
        location: 'Warszawa',
        locationCoords: { lat: 52.2297, lng: 21.0122 },
        level: 'pro',
        price: 150,
        time: 3,
        services: []
      },
      {
        name: 'Anna Nowak',
        email: 'anna.nowak@example.com',
        password: 'password123',
        role: 'provider',
        location: 'Warszawa',
        locationCoords: { lat: 52.2370, lng: 21.0175 },
        level: 'standard',
        price: 100,
        time: 2,
        services: []
      },
      {
        name: 'Piotr Wiśniewski',
        email: 'piotr.wisniewski@example.com',
        password: 'password123',
        role: 'provider',
        location: 'Warszawa',
        locationCoords: { lat: 52.2324, lng: 21.0063 },
        level: 'basic',
        price: 80,
        time: 1,
        services: []
      }
    ];

    // Dodaj nowych dostawców
    for (const provider of providers) {
      const hashedPassword = await bcrypt.hash(provider.password, 10);
      await User.create({
        ...provider,
        password: hashedPassword
      });
    }

    console.log('Dostawcy usług zostali utworzeni ponownie z pełnymi danymi');
    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Błąd połączenia z MongoDB:', err);
  }); 