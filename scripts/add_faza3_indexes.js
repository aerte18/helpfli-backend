?// Skrypt do dodania dodatkowych indeksów dla FAZY 3
// Uruchom: node backend/scripts/add_faza3_indexes.js

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Rating = require('../models/Rating');
const Portfolio = require('../models/Portfolio');
const VideoSession = require('../models/VideoSession');
const Order = require('../models/Order');
const Referral = require('../models/Referral');

async function addIndexes() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z MongoDB');

    // Rating - dodatkowe indeksy dla często używanych zapytań
    console.log('📊 Dodawanie indeksów dla Rating...');
    await Rating.collection.createIndex({ to: 1, status: 1, verified: 1, createdAt: -1 });
    await Rating.collection.createIndex({ from: 1, createdAt: -1 });
    await Rating.collection.createIndex({ rating: 1, status: 1 }); // Dla sortowania po ocenie
    console.log('✅ Rating indexes added');

    // Portfolio - dodatkowe indeksy
    console.log('📊 Dodawanie indeksów dla Portfolio...');
    await Portfolio.collection.createIndex({ provider: 1, status: 1, featured: -1, createdAt: -1 });
    await Portfolio.collection.createIndex({ category: 1, service: 1, status: 1 });
    await Portfolio.collection.createIndex({ tags: 1, status: 1 }); // Dla wyszukiwania po tagach
    console.log('✅ Portfolio indexes added');

    // VideoSession - dodatkowe indeksy
    console.log('📊 Dodawanie indeksów dla VideoSession...');
    await VideoSession.collection.createIndex({ client: 1, status: 1, scheduledAt: -1 });
    await VideoSession.collection.createIndex({ provider: 1, status: 1, scheduledAt: -1 });
    await VideoSession.collection.createIndex({ order: 1 }); // Dla powiązania ze zleceniem
    await VideoSession.collection.createIndex({ scheduledAt: 1, status: 1 }); // Dla zapytań po dacie
    console.log('✅ VideoSession indexes added');

    // Order - dodatkowe indeksy dla AI i integracji
    console.log('📊 Dodawanie indeksów dla Order...');
    await Order.collection.createIndex({ status: 1, createdAt: -1, service: 1 }); // Dla dashboardów
    await Order.collection.createIndex({ aiTags: 1 }); // Dla wyszukiwania po tagach AI
    await Order.collection.createIndex({ 'calendarEvents.provider': 1 }); // Dla integracji kalendarza
    console.log('✅ Order indexes added');

    // Referral - dodatkowe indeksy
    console.log('📊 Dodawanie indeksów dla Referral...');
    await Referral.collection.createIndex({ code: 1 }, { unique: true }); // Jeśli jeszcze nie ma
    await Referral.collection.createIndex({ referrer: 1, status: 1, createdAt: -1 });
    await Referral.collection.createIndex({ referred: 1, status: 1 });
    console.log('✅ Referral indexes added');

    console.log('\n✅ Wszystkie indeksy zostały dodane pomyślnie!');
    
    // Wyświetl statystyki indeksów
    console.log('\n📊 Statystyki indeksów:');
    const collections = ['ratings', 'portfolioitems', 'videosessions', 'orders', 'referrals'];
    for (const collName of collections) {
      try {
        const stats = await mongoose.connection.db.collection(collName).indexes();
        console.log(`  ${collName}: ${stats.length} indeksów`);
      } catch (e) {
        console.log(`  ${collName}: nie znaleziono`);
      }
    }

    await mongoose.connection.close();
    console.log('\n✅ Zakończono');
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

addIndexes();













