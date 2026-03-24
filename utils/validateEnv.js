/**
 * Walidacja wymaganych zmiennych środowiskowych
 * Uruchamia się przy starcie aplikacji
 */

const requiredVars = {
  // Zawsze wymagane
  always: [
    'JWT_SECRET',
    'MONGO_URI'
  ],
  // Wymagane w produkcji
  production: [
    'FRONTEND_URL',
    'SERVER_URL',
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY'
  ]
};

const optionalVars = {
  // Opcjonalne, ale zalecane
  recommended: [
    'SENTRY_DSN',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS'
  ]
};

function validateEnv() {
  const errors = [];
  const warnings = [];
  const isProduction = process.env.NODE_ENV === 'production';

  // Sprawdź zawsze wymagane zmienne
  for (const varName of requiredVars.always) {
    if (!process.env[varName]) {
      errors.push(`❌ WYMAGANE: ${varName} nie jest ustawione`);
    } else if (varName === 'JWT_SECRET' && process.env[varName].length < 32) {
      warnings.push(`⚠️ OSTRZEŻENIE: ${varName} jest zbyt krótkie (min. 32 znaki dla bezpieczeństwa)`);
    }
  }

  // Sprawdź wymagane w produkcji
  if (isProduction) {
    for (const varName of requiredVars.production) {
      if (!process.env[varName]) {
        errors.push(`❌ WYMAGANE W PRODUKCJI: ${varName} nie jest ustawione`);
      }
    }
  }

  // Sprawdź zalecane zmienne
  for (const varName of optionalVars.recommended) {
    if (!process.env[varName]) {
      warnings.push(`💡 ZALECANE: ${varName} nie jest ustawione (niektóre funkcje mogą nie działać)`);
    }
  }

  // Walidacja formatów
  if (process.env.MONGO_URI && !process.env.MONGO_URI.startsWith('mongodb://') && !process.env.MONGO_URI.startsWith('mongodb+srv://')) {
    errors.push(`❌ MONGO_URI ma nieprawidłowy format (musi zaczynać się od mongodb:// lub mongodb+srv://)`);
  }

  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    warnings.push(`⚠️ STRIPE_SECRET_KEY może być nieprawidłowy (powinien zaczynać się od sk_test_ lub sk_live_)`);
  }

  if (process.env.STRIPE_PUBLISHABLE_KEY && !process.env.STRIPE_PUBLISHABLE_KEY.startsWith('pk_')) {
    warnings.push(`⚠️ STRIPE_PUBLISHABLE_KEY może być nieprawidłowy (powinien zaczynać się od pk_test_ lub pk_live_)`);
  }

  // Użyj loggera zamiast console.log
  const logger = require('./logger');

  // Wyświetl ostrzeżenia
  if (warnings.length > 0) {
    logger.warn('\n⚠️  OSTRZEŻENIA KONFIGURACJI:');
    warnings.forEach(w => logger.warn(`   ${w}`));
  }

  // Wyświetl błędy i zakończ jeśli są krytyczne
  if (errors.length > 0) {
    logger.error('\n❌ BŁĘDY KONFIGURACJI:');
    errors.forEach(e => logger.error(`   ${e}`));
    
    if (isProduction) {
      logger.error('\n❌ Aplikacja nie może zostać uruchomiona w produkcji z brakującymi zmiennymi środowiskowymi!');
      logger.error('   Ustaw wszystkie wymagane zmienne środowiskowe przed uruchomieniem.\n');
      // W testach nie wywołuj process.exit
      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
    } else {
      logger.warn('\n⚠️  Aplikacja będzie działać w trybie development, ale niektóre funkcje mogą nie działać poprawnie.\n');
    }
  }

  // Podsumowanie
  if (errors.length === 0 && warnings.length === 0) {
    logger.info('✅ Wszystkie zmienne środowiskowe są poprawnie skonfigurowane\n');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

module.exports = { validateEnv };

