/**
 * Zweryfikowane fakty platformy — źródło prawdy z kodu i konfiguracji.
 * Nie hardcodujemy marketingowych superlatyw; każdy fakt ma pole source.
 */

const pricingCfg = require('../config/pricing');
const offersOnlyPricing = require('../config/offersOnlyPricing');

function fact(code, statement, value, source, verified = true) {
  return {
    code,
    statement,
    value,
    verified,
    source,
    updatedAt: new Date().toISOString(),
  };
}

function getPlatformFacts() {
  const facts = [
    fact(
      'marketplace_type',
      'Marketplace usług lokalnych — klienci publikują zlecenia, wykonawcy składają oferty.',
      'marketplace_offers',
      'product_model'
    ),
    fact(
      'registration_model',
      'Rejestracja konta e-mail + hasło; role: client, provider, admin, company_owner, company_manager.',
      { roles: ['client', 'provider', 'admin', 'company_owner', 'company_manager'] },
      'backend/models/User.js'
    ),
    fact(
      'order_workflow',
      'Zlecenia przechodzą statusy: open → collecting_offers → accepted → in_progress → completed/rated.',
      {
        statuses: [
          'open',
          'collecting_offers',
          'accepted',
          'in_progress',
          'completed',
          'rated',
          'cancelled',
        ],
      },
      'backend/models/Order.js'
    ),
    fact(
      'platform_fee_percent_config',
      'Domyślna prowizja platformy w kalkulatorze cen: procent od kwoty bazowej (config pricing).',
      { platformFeePercent: pricingCfg.platformFeePercent },
      'backend/config/pricing.js'
    ),
    fact(
      'transaction_fee_percent_acceptance',
      'Prowizja przy akceptacji oferty: domyślnie 5% (z wyjątkami CLIENT_PRO i Founding Provider).',
      { defaultPercent: 5 },
      'backend/utils/foundingProvider.js computeOrderPlatformFee'
    ),
    fact(
      'provider_free_offers_limit',
      'Domyślny limit ofert miesięcznie dla wykonawcy FREE: 10 (z planu PROV_FREE / User.monthlyOffersLimit).',
      { monthlyOffersLimit: 10 },
      'backend/models/SubscriptionPlan.js, backend/utils/syncProviderSubscriptionLimits.js'
    ),
    fact(
      'offer_boost_fee_pln',
      'Opłata za wyróżnienie oferty po wyczerpaniu limitów: 5 PLN.',
      { amountPln: 5 },
      'backend/routes/offers.js'
    ),
    fact(
      'payments_provider',
      'Płatności online przez Stripe (wymaga STRIPE_SECRET_KEY).',
      { provider: 'stripe', configured: !!process.env.STRIPE_SECRET_KEY },
      'backend/routes/payments.js'
    ),
    fact(
      'payment_methods',
      'Obsługiwane metody: karta; Przelewy24 jeśli P24_MERCHANT_ID; BLIK przez Stripe.',
      {
        card: true,
        p24: !!process.env.P24_MERCHANT_ID,
        blik: true,
      },
      'backend/routes/integrations.js /payments/methods'
    ),
    fact(
      'verification_optional',
      'Weryfikacja wykonawcy (KYC / manual) jest opcjonalna; domyślny status: unverified.',
      { defaultStatus: 'unverified', methods: ['kyc_id', 'company_reg', 'manual'] },
      'backend/models/User.js verification'
    ),
    fact(
      'ratings_enabled',
      'System ocen 1–5 po zakończonych zleceniach.',
      { scaleMin: 1, scaleMax: 5 },
      'backend/models/Rating.js'
    ),
    fact(
      'offers_only_mode',
      'Tryb „tylko oferty” (lead gen): wystawienie 0 zł; monetyzacja przez odblokowanie kontaktu i boosty.',
      {
        contactUnlockFeePln: offersOnlyPricing.contactUnlockFeePln,
        orderMode: 'offers_only',
      },
      'backend/config/offersOnlyPricing.js'
    ),
    fact(
      'notifications_channels',
      'Powiadomienia: e-mail (Resend/SMTP), web-push (VAPID), in-app.',
      {
        email: !!(process.env.RESEND_API_KEY || process.env.SMTP_HOST),
        webPush: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
        inApp: true,
      },
      'backend/env.example, backend/models/Notification.js'
    ),
    fact(
      'ai_concierge',
      'AI Concierge pomaga klientom w diagnozie problemu i tworzeniu zlecenia.',
      { feature: 'ai_concierge', sourceField: 'Order.source ai|manual' },
      'backend/models/Order.js, backend/routes/ai.js'
    ),
    fact(
      'founding_provider_program',
      'Program Pierwszy wykonawca: limit miejsc, czas trwania benefitów, możliwa 0% prowizji w trakcie programu.',
      {
        limitPlaces: 1000,
        durationDays: 60,
        commissionDiscountPercent: 100,
      },
      'backend/utils/foundingProvider.js'
    ),
    fact(
      'welcome_credit_client',
      'Bonus powitalny klienta po pierwszym ukończonym zleceniu (growth).',
      { program: 'welcome_credit', eligibleField: 'firstOrderBonusEligible' },
      'backend/utils/growthRewards.js'
    ),
    fact(
      'geo_coverage_cities',
      'Agregacje geograficzne wspierają topowe miasta PL (lista kanoniczna w polishCities/seoCities).',
      { supportedCityList: 'TOP_PL_CITIES + SEO_CITIES' },
      'backend/utils/polishCities.js, backend/utils/seoCities.js'
    ),
    fact(
      'provider_availability_signal',
      'Status dostępności wykonawcy: provider_status.isOnline oraz ProviderProfile.availabilityNow.',
      { fields: ['provider_status.isOnline', 'ProviderProfile.availabilityNow'] },
      'backend/models/User.js, backend/models/ProviderProfile.js'
    ),
    fact(
      'no_guaranteed_order_volume',
      'Platforma nie gwarantuje minimalnej liczby zleceń dla wykonawców.',
      null,
      'code_audit',
      false
    ),
    fact(
      'no_24_7_platform_sla',
      'Brak udokumentowanego SLA dostępności platformy 24/7.',
      null,
      'code_audit',
      false
    ),
  ];

  return facts;
}

module.exports = { getPlatformFacts };
