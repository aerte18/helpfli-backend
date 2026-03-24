const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./User');
const bcrypt = require('bcryptjs');

dotenv.config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(async () => {
    console.log('Połączono z MongoDB');

    // Lista przykładowych dostawców usług
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
        avatar: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjNEY0NkU1Ii8+Cjx0ZXh0IHg9IjI0IiB5PSIyOCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE2IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+SkvCoDwvdGV4dD4KPC9zdmc+'
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
        avatar: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjRUM0ODk5Ii8+Cjx0ZXh0IHg9IjI0IiB5PSIyOCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE2IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+QU7CoDwvdGV4dD4KPC9zdmc+'
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
        avatar: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMTBCOTgxIi8+Cjx0ZXh0IHg9IjI0IiB5PSIyOCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE2IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+UFfCoDwvdGV4dD4KPC9zdmc+'
      }
    ];

    // Usuń istniejących dostawców (opcjonalnie)
    await User.deleteMany({ role: 'provider' });
    
    // Dodaj nowych dostawców
    for (const provider of providers) {
      const hashedPassword = await bcrypt.hash(provider.password, 10);
      await User.create({
        ...provider,
        password: hashedPassword
      });
    }

    console.log('Dostawcy usług zostali dodani');
    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Błąd połączenia z MongoDB:', err);
  }); 