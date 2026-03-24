require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Service = require('../models/Service');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Połączono z MongoDB');

    // Pobierz wszystkie usługi
    const services = await Service.find({}).lean();
    console.log(`📋 Znaleziono ${services.length} usług w bazie`);
    
    if (services.length === 0) {
      console.log('⚠️  Brak usług w bazie. Tworzę przykładowe usługi...');
      
      // Utwórz przykładowe usługi
      const exampleServices = [
        { name: 'Hydraulik', code: 'hydraulik' },
        { name: 'Elektryk', code: 'elektryk' },
        { name: 'Złota rączka', code: 'zlota_raczka' },
        { name: 'Malarz', code: 'malarz' },
        { name: 'Glazurnik', code: 'glazurnik' },
        { name: 'Stolarz', code: 'stolarz' }
      ];
      
      for (const svc of exampleServices) {
        await Service.create(svc);
      }
      
      const newServices = await Service.find({}).lean();
      console.log(`✅ Utworzono ${newServices.length} usług`);
      services.push(...newServices);
    }

    // Pobierz wszystkich wykonawców bez usług
    const providers = await User.find({ 
      role: 'provider',
      $or: [
        { services: { $exists: false } },
        { services: { $size: 0 } }
      ]
    }).lean();

    console.log(`👷 Znaleziono ${providers.length} wykonawców bez usług`);

    if (providers.length === 0) {
      console.log('ℹ️  Wszyscy wykonawcy mają już przypisane usługi');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Przypisz każdemu wykonawcy losową usługę (lub pierwszą dostępną)
    let assigned = 0;
    for (const provider of providers) {
      // Wybierz losową usługę
      const randomService = services[Math.floor(Math.random() * services.length)];
      
      await User.findByIdAndUpdate(provider._id, {
        $set: {
          services: [randomService._id],
          service: randomService.name_pl || randomService.name || 'Usługa' // Ustaw też główną usługę jako string
        }
      });

      const serviceName = randomService.name_pl || randomService.name || 'Usługa';
      console.log(`✅ Przypisano usługę "${serviceName}" do ${provider.name} (${provider.email})`);
      assigned++;
    }

    console.log(`\n🎉 Zakończono! Przypisano usługi do ${assigned} wykonawców`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
})();

