?require('dotenv').config();
const mongoose = require('mongoose');
const SponsorAd = require('../models/SponsorAd');

/**
 * Skrypt tworzący przykładową reklamę z animacją/wideo
 * Używa zewnętrznych linków do przykładowych mediów
 */
async function createExampleAnimatedAd() {
  try {
    // Połącz z bazą danych
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z bazą danych');

    // Sprawdź czy już istnieje przykładowa reklama animowana
    const existingAd = await SponsorAd.findOne({ 
      'advertiser.email': 'animacja@przyklad.pl' 
    });

    if (existingAd) {
      console.log('⚠️ Przykładowa reklama animowana już istnieje. Usuwam starą...');
      await SponsorAd.deleteOne({ _id: existingAd._id });
    }

    // Przykładowe linki do mediów (używamy darmowych zasobów)
    // UWAGA: Pexels blokuje bezpośrednie linki (403), więc używamy obrazów
    const exampleMedia = {
      // GIF animowany z Giphy (przykład) - może też być blokowany
      gif: 'https://media.giphy.com/media/3o7aCTPPm4OHfRLSH6/giphy.gif',
      
      // Wideo - NIE UŻYWAJ bezpośrednich linków z Pexels (403 Forbidden)
      // Zamiast tego użyj lokalnego pliku lub innego źródła
      // video: 'https://videos.pexels.com/video-files/3045163/3045163-hd_1920_1080_30fps.mp4',
      
      // Obraz statyczny - działa zawsze
      image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=1200&h=600&fit=crop'
    };

    // Utwórz reklamę z wideo (najbardziej efektowna)
    const animatedAd = await SponsorAd.create({
      advertiser: {
        companyName: 'MegaTools - Wypożyczalnia Profesjonalnych Narzędzi',
        email: 'animacja@przyklad.pl',
        phone: '+48 123 456 789',
        website: 'https://megatools.pl',
        nip: '1234567890',
        address: {
          street: 'ul. Narzędziowa 15',
          city: 'Warszawa',
          postalCode: '00-001',
          country: 'Polska'
        }
      },
      adType: 'tool_rental',
      title: 'Wypożycz Profesjonalne Narzędzie w 24h! 🔧',
      description: 'Wiertarki, szlifierki, młoty - wszystko czego potrzebujesz do remontu. Dostawa w 24h, ceny od 20zł/dzień. Sprawdź naszą ofertę!',
      keywords: ['narzędzia', 'wypożyczalnia', 'wiertarka', 'szlifierka', 'młot', 'remont', 'budowa', 'narzędzia budowlane'],
      serviceCategories: ['remont', 'budowa', 'instalacja'],
      orderTypes: ['repair', 'installation', 'maintenance'],
      locations: [
        { city: 'Warszawa', radius: 50 },
        { city: 'Kraków', radius: 50 },
        { city: 'Wrocław', radius: 50 }
      ],
      link: 'https://megatools.pl/wypozyczalnia',
      ctaText: 'Zobacz ofertę →',
      
      // Użyj obrazu (wideo z Pexels jest blokowane przez CORS/403)
      mediaType: 'image',
      imageUrl: exampleMedia.image, // Obraz narzędzi
      // videoUrl: undefined, // Wideo nie działa z zewnętrznych źródeł
      logoUrl: 'https://images.unsplash.com/photo-1504917595217-d4dc5ebe6122?w=200&h=200&fit=crop', // Logo
      
      campaign: {
        budget: 10000 * 100, // 10 000 zł w groszach
        spent: 0,
        pricingModel: 'package',
        packagePrice: 1999 * 100, // Pakiet Enterprise
        monthlyLimit: 999999,
        startDate: new Date(),
        endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 dni
        dailyBudget: 500 * 100, // 500 zł dziennie
        maxImpressions: 100000,
        maxClicks: 5000
      },
      
      status: 'active', // Aktywna od razu (dla testów)
      priority: 10, // Najwyższy priorytet (Enterprise)
      package: 'enterprise',
      displayLocations: [
        'landing_page_banner',
        'ai_concierge',
        'search_results',
        'order_details',
        'between_items',
        'provider_list',
        'my_orders',
        'available_orders'
      ],
      stats: {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: 0,
        avgPosition: 0
      },
      
      details: {
        tool_rental: {
          categories: ['power_tools', 'hand_tools', 'heavy_machinery'],
          deliveryAvailable: true,
          pickupAvailable: true,
          sameDayDelivery: true,
          insuranceIncluded: true
        }
      }
    });

    console.log('\n✅ Utworzono przykładową reklamę animowaną:');
    console.log(`   ID: ${animatedAd._id}`);
    console.log(`   Tytuł: ${animatedAd.title}`);
    console.log(`   Status: ${animatedAd.status}`);
    console.log(`   Typ mediów: ${animatedAd.mediaType}`);
    console.log(`   Wideo URL: ${animatedAd.videoUrl}`);
    console.log(`   Budżet: ${(animatedAd.campaign.budget / 100).toFixed(2)} zł`);
    console.log(`   Data końca: ${new Date(animatedAd.campaign.endDate).toLocaleDateString('pl-PL')}`);
    console.log(`   Słowa kluczowe: ${animatedAd.keywords.join(', ')}`);
    
    console.log('\n📝 Reklama będzie widoczna w:');
    console.log('   - Banner na stronie głównej (z wideo w tle)');
    console.log('   - Odpowiedziach AI Concierge (gdy użytkownik szuka narzędzi)');
    console.log('   - Wyszukiwaniu (sidebar)');
    console.log('   - Szczegółach zlecenia (sidebar)');
    console.log('   - Między zleceniami');
    
    console.log('\n💡 Aby zobaczyć reklamę:');
    console.log('   1. Otwórz stronę główną - powinien być banner z wideo');
    console.log('   2. Otwórz AI Concierge');
    console.log('   3. Zapytaj: "Potrzebuję wiertarkę do remontu"');
    console.log('   4. AI powinno polecić tę reklamę z odtwarzającym się wideo');
    
    console.log('\n🎬 Wideo będzie odtwarzane automatycznie, w pętli, bez dźwięku');
    console.log('   (zgodnie z najlepszymi praktykami reklam online)');
    
    console.log('\n✅ Gotowe!');

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

// Uruchom skrypt
createExampleAnimatedAd();

