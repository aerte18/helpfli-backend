require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/SubscriptionPlan');

const plans = [
  // Klienci
  {
    key: 'CLIENT_FREE',
    name: 'FREE (klient)',
    priceMonthly: 0,
    priceYearly: 0,
    perks: ['Podstawowy dostęp', '50 zapytań AI/mies.', 'AI Camera Assistant', '1 darmowy Fast-Track/mies.'],
    feeDiscountPercent: 0,
    platformFeePercent: 15,
    freeExpressPerMonth: 1, // 1 darmowy Fast-Track/mies jako zachęta
    zeroCommission: false,
  },
  {
    key: 'CLIENT_STD',
    name: 'STANDARD (klient)',
    priceMonthly: 19,
    priceYearly: 182,
    perks: ['AI nielimit', 'AI Camera Assistant (streaming, AR)', 'Pilne zlecenia bezpłatne (bez limitu)', '-10% na wyróżnionych', 'Niższe platform fee (8%)'],
    feeDiscountPercent: 10,
    platformFeePercent: 8,
    freeExpressPerMonth: 0,
    zeroCommission: false,
  },
  {
    key: 'CLIENT_PRO',
    name: 'PRO (klient)',
    priceMonthly: 49,
    priceYearly: 470,
    perks: ['AI nielimit', 'AI Camera Assistant (wszystkie funkcje)', 'Pilne zlecenia bezpłatne (bez limitu)', '3 darmowe boosty ofert/mies.', 'Priorytet do top wykonawców', 'Brak platform fee (0%)'],
    feeDiscountPercent: 15,
    platformFeePercent: 0,
    freeExpressPerMonth: 0,
    freeBoostsPerMonth: 3, // 3 darmowe boosty/mies dla PRO
    zeroCommission: false,
  },
  // Usługodawcy
  {
    key: 'PROV_FREE',
    name: 'FREE (usługodawca)',
    priceMonthly: 0,
    priceYearly: 0,
    perks: ['Odpowiedzi: 10/mies.', 'Profil podstawowy'],
    platformFeePercent: 15,
    providerOffersLimit: 10,
    providerTier: 'basic',
  },
  {
    key: 'PROV_STD',
    name: 'STANDARD (usługodawca)',
    priceMonthly: 49,
    priceYearly: 470,
    perks: ['Odpowiedzi: 50/mies.', 'Profil rozszerzony', 'Statystyki', 'AI Chat', 'Niższe platform fee (8%)'],
    platformFeePercent: 8,
    providerOffersLimit: 50,
    providerTier: 'standard',
  },
  {
    key: 'PROV_STD_PLUS',
    name: 'STANDARD+ (usługodawca)',
    priceMonthly: 79,
    priceYearly: 758,
    perks: ['Odpowiedzi: 100/mies.', 'Profil rozszerzony', 'Statystyki zaawansowane', 'AI Chat nielimitowane', 'Priorytet w wynikach (średni)', 'Platform fee: 7%'],
    platformFeePercent: 7,
    providerOffersLimit: 100,
    providerTier: 'standard',
  },
  {
    key: 'PROV_PRO',
    name: 'PRO (usługodawca)',
    priceMonthly: 99,
    priceYearly: 950,
    perks: ['Odpowiedzi: nielimitowane', 'Priorytet w wynikach', 'Zaawansowane statystyki', 'Badge Helpfli PRO', 'Raporty PDF', 'Brak platform fee (0%)'],
    platformFeePercent: 0,
    providerOffersLimit: 999999,
    providerTier: 'pro',
  },
  // Pakiety firmowe B2B
  {
    key: 'BUSINESS_FREE',
    name: 'BUSINESS FREE',
    priceMonthly: 0,
    priceYearly: 0,
    perks: [
      'Odpowiedzi: 20/mies. (wspólna pula dla zespołu)',
      'Asystent AI: 100 zapytań/mies. (wspólna pula)',
      'Pilne zlecenia bezpłatne',
      'Zarządzanie zespołem (do 3 użytkowników)',
      'Portfel firmowy',
      'Podstawowa analityka',
      'Platform fee: 15%'
    ],
    platformFeePercent: 15,
    providerOffersLimit: 20,
    providerTier: 'basic',
    maxUsers: 3,
    businessFeatures: ['team_management', 'wallet', 'basic_analytics'] // Ograniczone funkcje
  },
  {
    key: 'BUSINESS_STANDARD',
    name: 'BUSINESS STANDARD',
    priceMonthly: 149,
    priceYearly: 1430,
    perks: [
      'Odpowiedzi: 200/mies. (wspólna pula dla zespołu)',
      'Asystent AI: 1000 zapytań/mies. (wspólna pula)',
      'Pilne zlecenia bezpłatne',
      'Wszystkie funkcje z FREE',
      'Zaawansowane statystyki i analityka',
      'Priorytet w wynikach wyszukiwania',
      'Analityka wydajności zespołu',
      'Raporty i eksport danych',
      'Platform fee: 8%',
      'Do 10 użytkowników w zespole'
    ],
    platformFeePercent: 8,
    providerOffersLimit: 200,
    providerTier: 'standard',
    maxUsers: 10,
    active: true,
    businessFeatures: ['team_management', 'wallet', 'invoices', 'workflow', 'roles', 'audit_log', 'analytics', 'advanced_stats', 'priority_ranking', 'team_performance', 'reports_export']
  },
  {
    key: 'BUSINESS_PRO',
    name: 'BUSINESS PRO',
    priceMonthly: 399,
    priceYearly: 3830,
    perks: [
      'Odpowiedzi: nielimitowane (wspólna pula dla zespołu)',
      'Asystent AI: nielimitowane (wspólna pula)',
      'Pilne zlecenia bezpłatne',
      'Podbicie ofert bezpłatne',
      'Wszystkie funkcje z STANDARD',
      'Pełna analityka i raporty',
      'API access dla integracji',
      'White-label opcje',
      'Dedicated support 24/7',
      'Custom integrations',
      'Platform fee: 5%',
      'Do 20 użytkowników w zespole'
    ],
    platformFeePercent: 5,
    providerOffersLimit: 999999,
    providerTier: 'pro',
    maxUsers: 20,
    active: true,
    businessFeatures: ['team_management', 'wallet', 'invoices', 'workflow', 'roles', 'audit_log', 'analytics', 'advanced_stats', 'priority_ranking', 'team_performance', 'reports_export', 'api_access', 'white_label', 'custom_integrations', 'dedicated_support']
  },
];

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    await SubscriptionPlan.deleteMany({});
    const created = await SubscriptionPlan.insertMany(plans);
    
    console.log(`\n✅ Zaseedowano ${created.length} planów:`);
    created.forEach(p => {
      console.log(`  - ${p.key}: ${p.name} (${p.priceMonthly} zł/mies.)`);
    });
    
    const businessPlans = created.filter(p => p.key.startsWith('BUSINESS_'));
    console.log(`\n📊 Plany biznesowe: ${businessPlans.length}`);
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
})();

