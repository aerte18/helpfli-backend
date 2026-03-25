/**
 * Skrypt do utworzenia przykładowej reklamy sponsorowanej
 * Uruchom: node backend/scripts/createExampleSponsorAd.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const SponsorAd = require('../models/SponsorAd');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli';

async function createExampleAd() {
  try {
    // Połącz z bazą danych
    await mongoose.connect(MONGO_URI);
    console.log('✅ Połączono z bazą danych');

    // Sprawdź czy już istnieje przykładowa reklama
    const existing = await SponsorAd.findOne({ 
      'advertiser.email': 'przyklad@sklepagd.pl' 
    });
    
    if (existing) {
      console.log('⚠️ Przykładowa reklama już istnieje. Usuwam starą...');
      await SponsorAd.deleteOne({ _id: existing._id });
    }

    // Utwórz przykładową reklamę
    const exampleAd = await SponsorAd.create({
      advertiser: {
        companyName: 'Sklep z Częściami AGD - Warszawa',
        email: 'przyklad@sklepagd.pl',
        phone: '+48 123 456 789',
        website: 'https://sklepagd.pl',
        nip: '1234567890',
        address: {
          street: 'ul. Przykładowa 123',
          city: 'Warszawa',
          postalCode: '00-001',
          country: 'Polska'
        }
      },
      adType: 'parts_store',
      title: 'Sklep z częściami AGD - Szybka dostawa',
      description: 'Szeroki wybór części do pralek, zmywarek, lodówek i innych urządzeń AGD. Dostawa w 24h w całej Polsce. Profesjonalna obsługa i gwarancja jakości.',
      keywords: ['pralka', 'AGD', 'części', 'naprawa', 'zmywarka', 'lodówka', 'suszarka', 'kuchenka'],
      serviceCategories: ['hydraulik', 'elektryk', 'AGD', 'naprawa'],
      orderTypes: ['repair', 'installation', 'maintenance'],
      locations: [
        {
          city: 'Warszawa',
          radius: 50 // 50 km
        }
      ],
      link: 'https://sklepagd.pl',
      ctaText: 'Sprawdź ofertę',
      campaign: {
        budget: 500000, // 5000 zł w groszach
        spent: 0,
        pricingModel: 'cpc',
        pricePerClick: 200, // 2 zł za kliknięcie
        pricePerImpression: 50, // 0.50 zł za wyświetlenie
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 dni od teraz
        dailyBudget: 50000, // 500 zł dziennie
        maxImpressions: 10000,
        maxClicks: 2500,
        notificationSent: false
      },
      details: {
        partsStore: {
          categories: ['AGD', 'elektronika', 'hydraulika'],
          deliveryAvailable: true,
          deliveryPrice: 1500, // 15 zł
          pickupAvailable: true
        }
      },
      status: 'active', // Aktywna od razu (dla testów)
      priority: 10, // Wysoki priorytet
      package: 'enterprise', // Pakiet Enterprise (wszystkie pozycje)
      displayLocations: [
        'landing_page_banner', // Banner na stronie głównej
        'ai_concierge', // Polecanie w AI
        'search_results', // Sidebar w wyszukiwaniu
        'order_details', // Sidebar w szczegółach zlecenia
        'between_items', // Między zleceniami
        'provider_list', // Lista wykonawców
        'my_orders', // Moje zlecenia
        'available_orders' // Dostępne zlecenia
      ],
      stats: {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: 0,
        avgPosition: 0
      },
      moderation: {
        reviewedBy: null, // Dla testów - bez moderacji
        reviewedAt: new Date(),
        notes: 'Przykładowa reklama testowa'
      }
    });

    console.log('✅ Utworzono przykładową reklamę:');
    console.log(`   ID: ${exampleAd._id}`);
    console.log(`   Tytuł: ${exampleAd.title}`);
    console.log(`   Status: ${exampleAd.status}`);
    console.log(`   Budżet: ${(exampleAd.campaign.budget / 100).toFixed(2)} zł`);
    console.log(`   Data końca: ${exampleAd.campaign.endDate.toLocaleDateString('pl-PL')}`);
    console.log(`   Słowa kluczowe: ${exampleAd.keywords.join(', ')}`);
    console.log('\n📝 Reklama będzie widoczna w:');
    console.log('   - Odpowiedziach AI Concierge (gdy użytkownik szuka "pralka", "AGD", "części")');
    console.log('   - Na stronie głównej (banner)');
    console.log('   - W wyszukiwaniu (sidebar)');
    console.log('   - W szczegółach zlecenia (sidebar)');
    console.log('\n💡 Aby zobaczyć reklamę:');
    console.log('   1. Otwórz AI Concierge');
    console.log('   2. Zapytaj: "Zepsuła się pralka, potrzebuję części"');
    console.log('   3. AI powinno polecić tę reklamę');

    await mongoose.disconnect();
    console.log('\n✅ Gotowe!');
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

// Uruchom skrypt
createExampleAd();

