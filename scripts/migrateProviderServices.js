const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const User = require('../models/User');
const Service = require('../models/Service');

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');

async function migrateProviderServices() {
  try {
    console.log('🔄 Migruję usługi providerów do nowego systemu...');

    // Znajdź wszystkich providerów
    const providers = await User.find({ role: 'provider' });
    console.log(`📋 Znaleziono ${providers.length} providerów`);

    for (const provider of providers) {
      console.log(`\n👤 Przetwarzam: ${provider.name} (${provider.email})`);
      
      if (!provider.services || provider.services.length === 0) {
        console.log('   ⏭️  Brak usług - pomijam');
        continue;
      }

      const newServices = [];
      
      for (const serviceId of provider.services) {
        console.log(`   🔍 Sprawdzam usługę: ${serviceId}`);
        const service = await Service.findById(serviceId);
        
        if (!service) {
          console.log(`   ❌ Usługa ${serviceId} nie istnieje`);
          continue;
        }
        
        console.log(`   📋 Usługa: ${JSON.stringify(service, null, 2)}`);

        // Jeśli to stara usługa (ma tylko 'name'), znajdź odpowiednie usługi w nowym systemie
        if (service.name && !service.parent_slug && !service.name_pl) {
          console.log(`   🔄 Migruję starą usługę: ${service.name} (ID: ${service._id})`);
          
          // Mapowanie starych nazw na nowe kategorie
          const categoryMapping = {
            'Hydraulik': 'hydraulika',
            'Elektryk': 'elektryka',
            'AGD': 'agd',
            'Złota rączka': 'montaz',
            'Malowanie': 'remont'
          };

          const newCategory = categoryMapping[service.name];
          if (newCategory) {
            // Znajdź wszystkie usługi w tej kategorii
            const categoryServices = await Service.find({ parent_slug: newCategory });
            console.log(`   ✅ Znaleziono ${categoryServices.length} usług w kategorii ${newCategory}`);
            
            // Dodaj wszystkie usługi z kategorii
            categoryServices.forEach(catService => {
              if (!newServices.find(s => s.toString() === catService._id.toString())) {
                newServices.push(catService._id);
              }
            });
          } else {
            console.log(`   ⚠️  Nieznana kategoria dla: ${service.name}`);
          }
        } else if (service.parent_slug) {
          // To już nowa usługa - dodaj ją
          console.log(`   ✅ Nowa usługa: ${service.name_pl || service.name_en || service.name}`);
          newServices.push(service._id);
        }
      }

      if (newServices.length > 0) {
        // Zaktualizuj usługi providera
        await User.findByIdAndUpdate(provider._id, { services: newServices });
        console.log(`   💾 Zaktualizowano: ${newServices.length} usług`);
        
        // Zaktualizuj główną usługę (pierwsza kategoria)
        const firstService = await Service.findById(newServices[0]);
        if (firstService && firstService.parent_slug) {
          const categoryNames = {
            'hydraulika': 'Hydraulika',
            'elektryka': 'Elektryka', 
            'agd': 'AGD i RTV',
            'klima_ogrz': 'Klimatyzacja i ogrzewanie',
            'remont': 'Remont i wykończenia',
            'montaz': 'Montaż i stolarka',
            'slusarz': 'Ślusarz i zabezpieczenia',
            'sprzatanie': 'Sprzątanie',
            'ogrod': 'Ogród i zew.',
            'auto_mobilne': 'Auto mobilnie',
            'it_smart': 'IT i Smart home',
            'zdrowie': 'Zdrowie (tele)',
            'zwierzeta': 'Zwierzęta (tele)',
            'pest': 'Dezynsekcja / szkodniki',
            'przeprowadzki': 'Przeprowadzki i transport',
            'gaz': 'Gaz / instalacje',
            'odpady': 'Wywóz / utylizacja',
            '24h': 'Awaryjne 24/7',
            'okna_drzwi': 'Okna i drzwi',
            'dach_rzyg': 'Dach i rynny',
            'podlogi': 'Podłogi',
            'mal_tap': 'Malowanie/Tapety',
            'inne': 'Inne / nie na liście'
          };
          
          const mainService = categoryNames[firstService.parent_slug] || firstService.parent_slug;
          await User.findByIdAndUpdate(provider._id, { service: mainService });
          console.log(`   🎯 Główna usługa: ${mainService}`);
        }
      }
    }

    console.log('\n✅ Migracja zakończona!');

  } catch (error) {
    console.error('❌ Błąd migracji:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Rozłączono z MongoDB');
  }
}

migrateProviderServices();
