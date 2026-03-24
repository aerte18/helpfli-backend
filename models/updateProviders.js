const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./User');

dotenv.config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(async () => {
    console.log('Połączono z MongoDB');

    // Update existing providers with new fields
    const providers = [
      {
        name: 'Jan Kowalski',
        locationCoords: { lat: 52.2297, lng: 21.0122 },
        level: 'pro',
        price: 150,
        time: 3
      },
      {
        name: 'Anna Nowak',
        locationCoords: { lat: 52.2370, lng: 21.0175 },
        level: 'standard',
        price: 100,
        time: 2
      },
      {
        name: 'Piotr Wiśniewski',
        locationCoords: { lat: 52.2324, lng: 21.0063 },
        level: 'basic',
        price: 80,
        time: 1
      }
    ];

    // Update each provider
    for (const provider of providers) {
      await User.findOneAndUpdate(
        { name: provider.name, role: 'provider' },
        {
          locationCoords: provider.locationCoords,
          level: provider.level,
          price: provider.price,
          time: provider.time
        }
      );
    }

    console.log('Dostawcy usług zostali zaktualizowani');
    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Błąd połączenia z MongoDB:', err);
  }); 