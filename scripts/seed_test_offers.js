?require('dotenv').config();
const mongoose = require('mongoose');
const Offer = require('../models/Offer');
const User = require('../models/User');
const Order = require('../models/Order');

async function main() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });

  // Znajdź providera
  const provider = await User.findOne({ role: 'provider' });
  if (!provider) {
    console.log('❌ Nie znaleziono providera w bazie');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`✅ Znaleziono providera: ${provider.email} (${provider.name})`);

  // Znajdź otwarte zlecenia
  const orders = await Order.find({ status: 'open' }).limit(5).lean();
  console.log(`✅ Znaleziono ${orders.length} otwartych zleceń`);

  if (orders.length === 0) {
    console.log('❌ Brak otwartych zleceń do utworzenia ofert');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Sprawdź istniejące oferty
  const existingOffers = await Offer.find({ providerId: provider._id }).lean();
  console.log(`📊 Istniejące oferty: ${existingOffers.length}`);

  // Utwórz testowe oferty dla pierwszych zleceń
  const offersToCreate = [];
  const amounts = [150, 200, 180, 250, 220];
  const messages = [
    'Jestem doświadczonym specjalistą, mogę wykonać to zlecenie szybko i profesjonalnie.',
    'Mam dostępne terminy już od jutra. Zapraszam do kontaktu.',
    'Wykonam pracę zgodnie z najwyższymi standardami. Gwarancja na wykonane usługi.',
    'Dysponuję odpowiednim sprzętem i doświadczeniem. Mogę rozpocząć od razu.',
    'Zapraszam do współpracy. Oferuję konkurencyjną cenę i terminową realizację.'
  ];

  for (let i = 0; i < Math.min(orders.length, 5); i++) {
    const order = orders[i];
    
    // Sprawdź czy już istnieje oferta dla tego zlecenia
    const existing = await Offer.findOne({
      orderId: order._id,
      providerId: provider._id
    });

    if (existing) {
      console.log(`⏭️  Oferta dla zlecenia ${order._id} już istnieje`);
      continue;
    }

    const offerData = {
      orderId: order._id,
      providerId: provider._id,
      amount: amounts[i] || 200,
      message: messages[i] || 'Zapraszam do współpracy.',
      completionDate: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000), // 1-5 dni od teraz
      status: i === 0 ? 'accepted' : i === 1 ? 'submitted' : 'submitted', // Pierwsza zaakceptowana, reszta oczekuje
      pricing: {
        service: order.service || 'inne',
        city: order.location?.city || null,
        bands: { min: 100, p25: 150, med: 200, p75: 250, max: 300, k: 1 },
        position: 'fair',
        badge: 'fair'
      }
    };

    offersToCreate.push(offerData);
  }

  if (offersToCreate.length === 0) {
    console.log('✅ Wszystkie oferty już istnieją');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Utwórz oferty
  const created = await Offer.insertMany(offersToCreate);
  console.log(`✅ Utworzono ${created.length} testowych ofert:`);
  
  created.forEach((offer, idx) => {
    console.log(`  ${idx + 1}. Kwota: ${offer.amount} zł, Status: ${offer.status}, Zlecenie: ${offer.orderId}`);
  });

  // Zaktualizuj licznik ofert u providera
  try {
    await User.updateOne(
      { _id: provider._id },
      { $inc: { monthlyOffersUsed: created.length } }
    );
    const updated = await User.findById(provider._id).lean();
    console.log(`✅ Zaktualizowano licznik ofert u providera: ${updated.monthlyOffersUsed || 0}`);
  } catch (error) {
    console.log(`⚠️  Nie udało się zaktualizować licznika ofert: ${error.message}`);
  }

  await mongoose.disconnect();
  console.log('✅ Gotowe!');
}

main().catch((e) => {
  console.error('❌ Błąd:', e);
  process.exit(1);
});

