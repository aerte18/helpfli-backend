?// Skrypt do dodania indeksów MongoDB dla optymalizacji zapytań
// Uruchom: node scripts/add_indexes_optimization.js

const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Rating = require('../models/Rating');
const Service = require('../models/Service');

async function addIndexes() {
  try {
    console.log('🔍 Dodawanie indeksów MongoDB...');

    // Połącz z bazą
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/helpfli';
    await mongoose.connect(mongoUri);
    console.log('✅ Połączono z MongoDB');

    // 1. Indeksy dla User (recommendProviders)
    console.log('\n📊 Dodawanie indeksów dla User...');
    
    // Indeks dla zapytania: { role: 'provider', services: serviceId }
    await User.collection.createIndex({ role: 1, services: 1 });
    console.log('  ✓ role + services');

    // Indeks dla zapytania: { role: 'provider', 'provider_status.isOnline': true }
    await User.collection.createIndex({ role: 1, 'provider_status.isOnline': 1 });
    console.log('  ✓ role + provider_status.isOnline');

    // Indeks dla lokalizacji (geospatial)
    await User.collection.createIndex({ locationLat: 1, locationLon: 1 });
    console.log('  ✓ locationLat + locationLon');

    // Indeks dla providerTier (używany w scoringu)
    await User.collection.createIndex({ providerTier: 1 });
    console.log('  ✓ providerTier');

    // Indeks dla verified (używany w scoringu)
    await User.collection.createIndex({ verified: 1 });
    console.log('  ✓ verified');

    // Indeks złożony dla zapytań w search
    await User.collection.createIndex({ role: 1, providerTier: -1, verified: -1 });
    console.log('  ✓ role + providerTier + verified (złożony)');

    // 2. Indeksy dla Order (używane w recommendProviders do obliczania statystyk)
    console.log('\n📊 Dodawanie indeksów dla Order...');
    
    // Indeks dla agregacji: { createdAt: { $gte: since }, service: serviceId, provider: providerId }
    await Order.collection.createIndex({ createdAt: -1, service: 1, provider: 1 });
    console.log('  ✓ createdAt + service + provider');

    // Indeks dla statusu i daty
    await Order.collection.createIndex({ status: 1, createdAt: -1 });
    console.log('  ✓ status + createdAt');

    // Indeks dla provider i statusu (używany w statystykach)
    await Order.collection.createIndex({ provider: 1, status: 1 });
    console.log('  ✓ provider + status');

    // Indeks dla paidInSystem (używany w scoringu)
    await Order.collection.createIndex({ provider: 1, paidInSystem: 1 });
    console.log('  ✓ provider + paidInSystem');

    // 3. Indeksy dla Rating (używane w recommendProviders)
    console.log('\n📊 Dodawanie indeksów dla Rating...');
    
    // Indeks dla zapytania: { to: providerId }
    await Rating.collection.createIndex({ to: 1 });
    console.log('  ✓ to (provider)');

    // Indeks złożony dla szybkiego pobierania ocen
    await Rating.collection.createIndex({ to: 1, rating: -1 });
    console.log('  ✓ to + rating');

    // 4. Indeksy dla Service (używane w mapowaniu serviceCode -> serviceId)
    console.log('\n📊 Dodawanie indeksów dla Service...');
    
    // Indeks dla code (używany w recommendProviders)
    await Service.collection.createIndex({ code: 1 });
    console.log('  ✓ code');

    // Indeks dla name (używany w wyszukiwaniu)
    await Service.collection.createIndex({ name: 1 });
    console.log('  ✓ name');

    // 5. Indeksy dla Order (dynamiczne ceny - computePriceHints)
    console.log('\n📊 Dodawanie indeksów dla dynamicznych cen...');
    
    // Indeks dla zapytania: { status: { $in: [...] }, createdAt: { $gte: last24h }, locationLat, locationLon }
    await Order.collection.createIndex({ 
      status: 1, 
      createdAt: -1, 
      locationLat: 1, 
      locationLon: 1 
    });
    console.log('  ✓ status + createdAt + locationLat + locationLon');

    console.log('\n✅ Wszystkie indeksy zostały dodane pomyślnie!');
    console.log('\n💡 Aby sprawdzić indeksy, użyj:');
    console.log('   db.users.getIndexes()');
    console.log('   db.orders.getIndexes()');
    console.log('   db.ratings.getIndexes()');

  } catch (error) {
    console.error('❌ Błąd podczas dodawania indeksów:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Rozłączono z MongoDB');
  }
}

// Uruchom jeśli wywołany bezpośrednio
if (require.main === module) {
  addIndexes();
}

module.exports = { addIndexes };













