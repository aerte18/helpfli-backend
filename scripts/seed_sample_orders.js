require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Service = require('../models/Service');

async function seedSampleOrders() {
  try {
    // Znajdź przykładowego providera (konto utworzone przez create_provider_user.js)
    const provider =
      await User.findOne({ email: 'provider@quicksy.local' }) ||
      await User.findOne({ email: 'provider@helpfli.local' });

    if (!provider) {
      throw new Error('Nie znaleziono konta providera. Najpierw uruchom: node scripts/create_provider_user.js');
    }

    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');

    // Znajdź lub utwórz przykładowego klienta
    let client = await User.findOne({ email: 'client@helpfli.test' });
    if (!client) {
      // Utwórz przykładowego klienta jeśli nie istnieje
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash('Test1234!', 10);
      client = await User.create({
        name: 'Jan Klient',
        email: 'client@helpfli.test',
        password: hashedPassword,
        role: 'client',
        emailVerified: true,
        isActive: true
      });
      console.log('✅ Created sample client');
    }

    // Pobierz przykładowe usługi
    const services = await Service.find().limit(10);
    if (services.length === 0) {
      console.log('⚠️  No services found. Creating sample services...');
      const sampleServices = [
        { name: 'Hydraulik', code: 'hydraulik' },
        { name: 'Elektryk', code: 'elektryk' },
        { name: 'AGD RTV', code: 'agd-rtv' },
        { name: 'Klimatyzacja Ogrzewanie', code: 'klimatyzacja-ogrzewanie' },
        { name: 'Stolarstwo Montaż', code: 'stolarstwo-montaz' },
        { name: 'Teleporada', code: 'teleporada' }
      ];
      for (const s of sampleServices) {
        await Service.create(s);
      }
      console.log('✅ Created sample services');
    }

    // Przykładowe zlecenia
    const sampleOrders = [
      {
        service: 'hydraulik',
        serviceDetails: 'Naprawa kranu',
        description: 'Kran w kuchni przecieka. Potrzebuję szybkiej naprawy.',
        location: 'Warszawa, ul. Marszałkowska 1',
        locationLat: 52.2297,
        locationLon: 21.0122,
        status: 'open',
        urgency: 'today',
        budget: 200,
        budgetRange: { min: 150, max: 300 }
      },
      {
        service: 'elektryk',
        serviceDetails: 'Montaż gniazdka',
        description: 'Potrzebuję zamontować nowe gniazdko elektryczne w salonie.',
        location: 'Kraków, ul. Floriańska 10',
        locationLat: 50.0647,
        locationLon: 19.9450,
        status: 'open',
        urgency: 'tomorrow',
        budget: 150,
        budgetRange: { min: 100, max: 200 }
      },
      {
        service: 'agd-rtv',
        serviceDetails: 'Naprawa pralki',
        description: 'Pralka nie odprowadza wody. Proszę o diagnozę i naprawę.',
        location: 'Wrocław, ul. Rynek 5',
        locationLat: 51.1079,
        locationLon: 17.0385,
        status: 'open',
        urgency: 'this_week',
        budget: 300,
        budgetRange: { min: 200, max: 400 }
      },
      {
        service: 'klimatyzacja-ogrzewanie',
        serviceDetails: 'Serwis klimatyzacji',
        description: 'Klimatyzacja w biurze nie działa. Potrzebuję serwisu.',
        location: 'Poznań, ul. Stary Rynek 1',
        locationLat: 52.4064,
        locationLon: 16.9252,
        status: 'open',
        urgency: 'flexible',
        budget: 500,
        budgetRange: { min: 400, max: 600 }
      },
      {
        service: 'teleporada',
        serviceDetails: 'Konsultacja z prawnikiem',
        description: 'Potrzebuję porady prawnej dotyczącej umowy najmu.',
        location: 'Gdańsk, ul. Długi Targ 1',
        locationLat: 54.3520,
        locationLon: 18.6466,
        status: 'open',
        urgency: 'now',
        budget: 250,
        budgetRange: { min: 200, max: 300 },
        isTeleconsultation: true
      },
      {
        service: 'stolarstwo-montaz',
        serviceDetails: 'Montaż mebli',
        description: 'Potrzebuję pomocy w montażu szafy w sypialni.',
        location: 'Łódź, ul. Piotrkowska 100',
        locationLat: 51.7592,
        locationLon: 19.4560,
        status: 'open',
        urgency: 'today',
        budget: 180,
        budgetRange: { min: 150, max: 250 }
      },
      {
        service: 'hydraulik',
        serviceDetails: 'Wymiana baterii',
        description: 'Chcę wymienić starą baterię w łazience na nową.',
        location: 'Katowice, ul. Mariacka 1',
        locationLat: 50.2649,
        locationLon: 19.0238,
        status: 'open',
        urgency: 'tomorrow',
        budget: 120,
        budgetRange: { min: 100, max: 150 }
      },
      {
        service: 'elektryk',
        serviceDetails: 'Naprawa instalacji',
        description: 'W mieszkaniu często wybija bezpieczniki. Potrzebuję diagnozy.',
        location: 'Szczecin, ul. Wały Chrobrego 1',
        locationLat: 53.4285,
        locationLon: 14.5528,
        status: 'open',
        urgency: 'this_week',
        budget: 350,
        budgetRange: { min: 300, max: 450 }
      }
    ];

    // Utwórz zlecenia
    let created = 0;
    let skipped = 0;
    for (const orderData of sampleOrders) {
      // Sprawdź czy zlecenie już istnieje (po lokalizacji i opisie)
      const existing = await Order.findOne({
        client: client._id,
        location: orderData.location,
        description: orderData.description
      });
      
      if (!existing) {
        await Order.create({
          ...orderData,
          client: client._id
        });
        created++;
        console.log(`✅ Created order: ${orderData.service} - ${orderData.serviceDetails}`);
      } else {
        skipped++;
        console.log(`⏭️  Order already exists: ${orderData.service} - ${orderData.serviceDetails}`);
      }
    }

    // Dodaj 1 przykładowe zlecenie przypisane bezpośrednio do providera
    const providerOrderDescription = 'Przykładowe zlecenie testowe przypisane do providera.';
    const existingProviderOrder = await Order.findOne({
      provider: provider._id,
      description: providerOrderDescription
    });

    if (!existingProviderOrder) {
      await Order.create({
        client: client._id,
        provider: provider._id,
        service: 'hydraulik',
        serviceDetails: 'Wymiana syfonu pod zlewem',
        description: providerOrderDescription,
        location: {
          lat: 52.2297,
          lng: 21.0122,
          address: 'Warszawa, ul. Nowy Świat 15'
        },
        locationLat: 52.2297,
        locationLon: 21.0122,
        city: 'Warszawa',
        status: 'accepted',
        urgency: 'today',
        budget: 250,
        budgetRange: { min: 200, max: 300 },
        preferredContact: 'chat',
        paymentPreference: 'system',
        paymentStatus: 'unpaid'
      });
      created++;
      console.log(`✅ Created provider order for: ${provider.email}`);
    } else {
      skipped++;
      console.log(`⏭️  Provider order already exists for: ${provider.email}`);
    }

    console.log(`\n✅ Seed completed! Created: ${created}, Skipped: ${skipped}`);
    console.log(`📊 Total open orders in database: ${await Order.countDocuments({ status: 'open' })}`);
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding orders:', error);
    process.exit(1);
  }
}

seedSampleOrders();

