/**
 * Skrypt do utworzenia przykładowego zlecenia z płatnością zewnętrzną (bez gwarancji Helpfli)
 * 
 * Użycie:
 * node backend/scripts/create-external-payment-order.js
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: '.env' });

const Order = require('../models/Order');
const User = require('../models/User');
const Offer = require('../models/Offer');

async function createExternalPaymentOrder() {
  try {
    // Połącz z bazą danych
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z bazą danych');

    // Znajdź klienta (pierwszego użytkownika z rolą 'client')
    const client = await User.findOne({ role: 'client' });
    if (!client) {
      console.error('❌ Nie znaleziono klienta. Utwórz najpierw użytkownika z rolą "client"');
      process.exit(1);
    }
    console.log(`✅ Znaleziono klienta: ${client.name || client.email} (${client._id})`);

    // Znajdź providera (pierwszego użytkownika z rolą 'provider')
    const provider = await User.findOne({ role: 'provider' });
    if (!provider) {
      console.error('❌ Nie znaleziono providera. Utwórz najpierw użytkownika z rolą "provider"');
      process.exit(1);
    }
    console.log(`✅ Znaleziono providera: ${provider.name || provider.email} (${provider._id})`);

    // Utwórz zlecenie z płatnością zewnętrzną
    const order = await Order.create({
      client: client._id,
      service: 'Hydraulik',
      serviceDetails: 'Naprawa kranu',
      description: 'Przecieka kran w kuchni, woda kapie na podłogę. Potrzebna szybka naprawa. Płatność bezpośrednio z wykonawcą.',
      location: 'Warszawa, ul. Przykładowa 123',
      locationLat: 52.2297,
      locationLon: 21.0122,
      city: 'Warszawa',
      status: 'collecting_offers',
      urgency: 'today',
      budget: 200,
      budgetRange: {
        min: 150,
        max: 250
      },
      contactPreference: 'phone',
      preferredContact: 'call',
      // PŁATNOŚĆ ZEWNĘTRZNA - bez gwarancji Helpfli
      paymentPreference: 'external', // 'external' = płatność poza systemem (bez gwarancji Helpfli)
      // paymentMethod w linii 56 modelu Order: enum ['system', 'external'] - użyjemy 'external'
      // Załączniki (przykładowe) - bez załączników na razie, żeby uniknąć błędów
      attachments: [],
      source: 'manual',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 dni
    });

    console.log(`✅ Utworzono zlecenie z płatnością zewnętrzną: ${order._id}`);
    console.log(`   Status: ${order.status}`);
    console.log(`   Payment Preference: ${order.paymentPreference}`);
    console.log(`   Payment Method: ${order.paymentMethod}`);

    // Utwórz ofertę od providera dla tego zlecenia
    // Model Offer: status enum: ["sent", "accepted", "rejected", "expired"]
    // contactMethod enum: ['call_before', 'chat_only', 'no_contact']
    const offer = await Offer.create({
      orderId: order._id,
      providerId: provider._id,
      amount: 180,
      price: 180,
      message: 'Naprawię kran w ciągu 2 godzin. Dojazd wliczony w cenę. Płatność gotówką lub przelewem bezpośrednio do mnie.',
      status: 'sent', // Poprawna wartość enum z modelu Offer
      // Nowe pola MVP
      priceInfo: {
        includes: ['labor', 'transport'],
        isFinal: true
      },
      etaMinutes: 120, // 2 godziny
      contactMethod: 'call_before', // Poprawna wartość enum z modelu Offer
      hasGuarantee: false, // Brak gwarancji Helpfli (płatność zewnętrzna)
      guaranteeDetails: 'Gwarancja własna - 30 dni na naprawę',
      notes: 'Mogę przyjechać dzisiaj po 14:00. Płatność bezpośrednio do mnie - gotówka lub przelew.',
      createdAt: new Date()
    });

    console.log(`✅ Utworzono ofertę: ${offer._id}`);
    console.log(`   Kwota: ${offer.amount} zł`);
    console.log(`   Has Guarantee: ${offer.hasGuarantee}`);
    console.log(`   Contact Method: ${offer.contactMethod}`);
    // Oferta jest już zapisana osobno w kolekcji Offer - nie trzeba dodawać do order.offers

    console.log('\n📋 PODSUMOWANIE:');
    console.log(`   Zlecenie ID: ${order._id}`);
    console.log(`   Klient: ${client.name || client.email}`);
    console.log(`   Provider: ${provider.name || provider.email}`);
    console.log(`   Oferta ID: ${offer._id}`);
    console.log(`   Kwota oferty: ${offer.amount} zł`);
    console.log(`   Płatność: ZEWNĘTRZNA (bez gwarancji Helpfli)`);
    console.log(`\n🔗 Link do zlecenia: http://localhost:5173/orders/${order._id}`);

    await mongoose.disconnect();
    console.log('\n✅ Zakończono. Połączono z bazą danych.');
    
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

// Uruchom skrypt
createExternalPaymentOrder();

