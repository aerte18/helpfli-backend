require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Połączono z bazą danych');

    // Znajdź użytkownika providera - najpierw spróbuj znaleźć po emailu z argumentu
    const userEmail = process.argv[2] || null;
    let provider = null;
    
    if (userEmail) {
      provider = await User.findOne({ email: userEmail });
      if (provider) {
        console.log(`✅ Znaleziono użytkownika po emailu: ${userEmail}`);
      } else {
        console.log(`⚠️ Nie znaleziono użytkownika o emailu: ${userEmail}`);
      }
    }
    
    // Jeśli nie znaleziono, użyj pierwszego dostępnego providera
    if (!provider) {
      provider = await User.findOne({ role: 'provider' });
    }
    
    if (!provider) {
      console.log('⚠️ Nie znaleziono providera, tworzę przykładowego...');
      provider = await User.create({
        name: 'Test Provider',
        email: 'test-provider@helpfli.test',
        password: 'Haslo!123',
        role: 'provider',
        providerTier: 'basic',
        monthlyOffersLimit: 10,
        monthlyOffersUsed: 8
      });
      console.log('✅ Utworzono testowego providera:', provider.email);
    } else {
      console.log('✅ Znaleziono providera:', provider.email, '(ID:', provider._id, ')');
    }

    // Usuń stare testowe powiadomienia
    await Notification.deleteMany({
      user: provider._id,
      type: { $in: ['limit_warning', 'limit_exceeded'] }
    });
    console.log('🧹 Usunięto stare testowe powiadomienia');

    // Utwórz przykładowe powiadomienia
    const notifications = [
      {
        user: provider._id,
        type: 'limit_warning',
        title: 'Niski limit ofert',
        message: `Zostało Ci 2 z 10 ofert w tym miesiącu. Rozważ ulepszenie pakietu.`,
        link: '/account/subscriptions',
        read: false,
        metadata: {
          limit: 10,
          used: 8,
          remaining: 2
        }
      },
      {
        user: provider._id,
        type: 'limit_exceeded',
        title: 'Przekroczono limit ofert',
        message: `Wykorzystałeś wszystkie oferty w tym miesiącu (10). Ulepsz pakiet aby zwiększyć limit.`,
        link: '/account/subscriptions',
        read: false,
        metadata: {
          limit: 10,
          used: 10,
          providerTier: 'basic',
          upsell: {
            recommendedPlanKey: 'PROV_STD',
            title: 'Standard (50 odpowiedzi / mies.)',
            description: 'Zwiększ limit odpowiedzi i odblokuj statystyki skuteczności ofert.'
          }
        }
      },
      {
        user: provider._id,
        type: 'limit_exceeded',
        title: 'Przekroczono limit AI Chat',
        message: `Wykorzystałeś wszystkie zapytania do AI Chat w tym miesiącu (20). Ulepsz pakiet Standard lub PRO aby uzyskać nielimitowany dostęp.`,
        link: '/account/subscriptions',
        read: false,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 godziny temu
        metadata: {
          limit: 20,
          used: 20,
          planKey: 'PROV_FREE',
          upsell: {
            recommendedPlanKey: 'PROV_STD',
            title: 'STANDARD – nielimitowany AI Chat',
            description: 'Uzyskaj nielimitowany dostęp do AI Chat i więcej odpowiedzi na zlecenia.'
          }
        }
      },
      {
        user: provider._id,
        type: 'limit_exceeded',
        title: 'Przekroczono limit odpowiedzi',
        message: `Wykorzystałeś wszystkie darmowe odpowiedzi w tym miesiącu (10). Wykup pakiet PRO lub zapłać za dodatkową odpowiedź.`,
        link: '/account/subscriptions',
        read: false,
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 godzin temu
        metadata: {
          limit: 10,
          used: 10,
          planKey: 'PROV_FREE',
          payPerUseAvailable: true,
          payPerUsePrice: 2.00,
          upsell: {
            recommendedPlanKey: 'PROV_PRO',
            title: 'PRO – nielimitowane odpowiedzi',
            description: 'Otrzymaj nielimitowany dostęp do składania ofert i zwiększ swoje szanse na zlecenia.'
          }
        }
      },
      {
        user: provider._id,
        type: 'new_quote',
        title: 'Nowa oferta',
        message: 'Otrzymałeś nową ofertę na zlecenie "Naprawa kranu w kuchni"',
        link: '/orders/123',
        read: false,
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 dzień temu
        metadata: {
          orderId: '123',
          offerId: '456'
        }
      },
      {
        user: provider._id,
        type: 'order_accepted',
        title: 'Oferta zaakceptowana',
        message: 'Twoja oferta na zlecenie "Instalacja oświetlenia" została zaakceptowana!',
        link: '/orders/789',
        read: false,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 dni temu
        metadata: {
          orderId: '789',
          offerId: '101112'
        }
      }
    ];

    const created = await Notification.insertMany(notifications);
    console.log(`✅ Utworzono ${created.length} przykładowych powiadomień:`);
    
    created.forEach((notif, idx) => {
      console.log(`   ${idx + 1}. [${notif.type}] ${notif.title} - ${notif.read ? 'Przeczytane' : 'Nieprzeczytane'}`);
    });

    console.log('\n📋 Powiadomienia są dostępne dla użytkownika:', provider.email);
    console.log('🔗 Zaloguj się jako ten użytkownik i sprawdź ikonę powiadomień w navbarze');

    await mongoose.disconnect();
    console.log('✅ Rozłączono z bazą danych');
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
})();

