require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Order = require('../models/Order');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    let client = await User.findOne({ email: 'client@helpfli.test' });
    if (!client) {
      const hashedPassword = await bcrypt.hash('Test1234!', 10);
      client = await User.create({
        name: 'Jan Klient',
        email: 'client@helpfli.test',
        password: hashedPassword,
        role: 'client',
        emailVerified: true,
        isActive: true
      });
      console.log('✅ Utworzono klienta testowego:', client.email);
    }

    const provider =
      await User.findOne({ email: 'provider@quicksy.local' }) ||
      await User.findOne({ email: 'provider@helpfli.local' });

    if (!provider) {
      throw new Error('Nie znaleziono providera. Uruchom najpierw: node scripts/create_provider_user.js');
    }

    const description = 'Przykładowe zlecenie testowe przypisane do providera.';
    const existing = await Order.findOne({
      provider: provider._id,
      description
    });

    if (existing) {
      console.log('⏭️  Zlecenie już istnieje:', existing._id.toString());
    } else {
      const order = await Order.create({
        client: client._id,
        provider: provider._id,
        service: 'hydraulik',
        serviceDetails: 'Wymiana syfonu pod zlewem',
        description,
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
      console.log('✅ Utworzono przykładowe zlecenie:', order._id.toString());
    }

    // Dodatkowe zlecenie OPEN do feedu providera (/api/orders/open)
    const openDescription = 'Przykładowe otwarte zlecenie dla feedu providera.';
    const existingOpen = await Order.findOne({
      client: client._id,
      description: openDescription
    });

    if (existingOpen) {
      console.log('⏭️  Otwarte zlecenie już istnieje:', existingOpen._id.toString());
    } else {
      const openOrder = await Order.create({
        client: client._id,
        service: 'hydraulik',
        serviceDetails: 'Cieknący syfon pod zlewem',
        description: openDescription,
        location: {
          lat: 52.2297,
          lng: 21.0122,
          address: 'Warszawa, ul. Marszałkowska 10'
        },
        locationLat: 52.2297,
        locationLon: 21.0122,
        city: 'Warszawa',
        status: 'open',
        urgency: 'today',
        budget: 220,
        budgetRange: { min: 180, max: 260 },
        preferredContact: 'chat',
        paymentPreference: 'system',
        paymentStatus: 'unpaid'
      });
      console.log('✅ Utworzono otwarte zlecenie do feedu:', openOrder._id.toString());
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd tworzenia zlecenia providera:', error);
    process.exit(1);
  }
})();
