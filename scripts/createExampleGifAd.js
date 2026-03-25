require('dotenv').config();
const mongoose = require('mongoose');
const SponsorAd = require('../models/SponsorAd');

/**
 * Skrypt tworzący przykładową reklamę z animowanym GIF
 */
async function createExampleGifAd() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z bazą danych');

    // Sprawdź czy już istnieje
    const existingAd = await SponsorAd.findOne({ 
      'advertiser.email': 'gif@przyklad.pl' 
    });

    if (existingAd) {
      console.log('⚠️ Przykładowa reklama GIF już istnieje. Usuwam starą...');
      await SponsorAd.deleteOne({ _id: existingAd._id });
    }

    // Przykładowy GIF animowany (z Giphy lub innego źródła)
    const gifUrl = 'https://media.giphy.com/media/l0MYC0Lajafpxw3sI/giphy.gif'; // Przykładowy GIF z narzędziami

    const gifAd = await SponsorAd.create({
      advertiser: {
        companyName: 'QuickFix - Naprawa AGD w 2h',
        email: 'gif@przyklad.pl',
        phone: '+48 987 654 321',
        website: 'https://quickfix.pl',
        nip: '9876543210',
        address: {
          street: 'ul. Szybka 42',
          city: 'Kraków',
          postalCode: '30-001',
          country: 'Polska'
        }
      },
      adType: 'service_provider',
      title: 'Naprawa AGD w 2h! ⚡ Szybko i Profesjonalnie',
      description: 'Zepsuła się pralka? Lodówka nie działa? Naprawiamy AGD w 2h! Dojazd gratis, gwarancja 12 miesięcy. Zadzwoń teraz!',
      keywords: ['naprawa', 'AGD', 'pralka', 'lodówka', 'szybka naprawa', 'serwis', 'elektryk', 'hydraulik'],
      serviceCategories: ['AGD', 'elektryk', 'naprawa'],
      orderTypes: ['repair', 'maintenance'],
      locations: [
        { city: 'Kraków', radius: 30 },
        { city: 'Warszawa', radius: 30 }
      ],
      link: 'https://quickfix.pl',
      ctaText: 'Zadzwoń teraz →',
      
      // GIF animowany
      mediaType: 'gif',
      imageUrl: gifUrl, // GIF będzie się odtwarzał automatycznie
      logoUrl: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=200&h=200&fit=crop',
      
      campaign: {
        budget: 5000 * 100, // 5000 zł
        spent: 0,
        pricingModel: 'package',
        packagePrice: 799 * 100, // Pakiet Premium
        monthlyLimit: 5000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 dni
        dailyBudget: 200 * 100,
        maxImpressions: 50000,
        maxClicks: 2500
      },
      
      status: 'active',
      priority: 7, // Premium
      package: 'premium',
      displayLocations: [
        'landing_page_banner',
        'ai_concierge',
        'search_results',
        'order_details',
        'between_items'
      ],
      stats: {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: 0,
        avgPosition: 0
      }
    });

    console.log('\n✅ Utworzono przykładową reklamę z GIF:');
    console.log(`   ID: ${gifAd._id}`);
    console.log(`   Tytuł: ${gifAd.title}`);
    console.log(`   Status: ${gifAd.status}`);
    console.log(`   Typ mediów: ${gifAd.mediaType}`);
    console.log(`   GIF URL: ${gifAd.imageUrl}`);
    console.log(`   Pakiet: Premium (799 zł/mies.)`);
    console.log(`   Słowa kluczowe: ${gifAd.keywords.join(', ')}`);
    
    console.log('\n📝 Reklama będzie widoczna w:');
    console.log('   - Banner na stronie głównej (z animowanym GIF)');
    console.log('   - Odpowiedziach AI Concierge');
    console.log('   - Wyszukiwaniu (sidebar)');
    console.log('   - Szczegółach zlecenia (sidebar)');
    console.log('   - Między zleceniami');
    
    console.log('\n💡 Aby zobaczyć reklamę:');
    console.log('   1. Otwórz stronę główną');
    console.log('   2. Zapytaj AI: "Zepsuła się pralka, potrzebuję naprawy"');
    console.log('   3. GIF będzie się animował automatycznie');
    
    console.log('\n🎬 GIF animowany będzie odtwarzany w pętli');
    console.log('   (automatyczna animacja, bez dźwięku)');
    
    console.log('\n✅ Gotowe!');

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

createExampleGifAd();






