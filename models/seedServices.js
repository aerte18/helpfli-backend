const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Service = require('./Service');

dotenv.config(); // Ładuje .env

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(async () => {
    console.log('Połączono z MongoDB');

    // Lista przykładowych usług
    const services = [
      { name: 'Hydraulik' },
      { name: 'Elektryk' },
      { name: 'Sprzątanie' },
      { name: 'Malowanie' },
      { name: 'Stolarz' },
      { name: 'Naprawa AGD' }
    ];

    await Service.deleteMany(); // (opcjonalnie) czyści stare dane
    await Service.insertMany(services);

    console.log('Usługi zostały dodane');
    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Błąd połączenia z MongoDB:', err);
  });
