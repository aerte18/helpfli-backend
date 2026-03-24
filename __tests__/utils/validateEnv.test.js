/**
 * Testy jednostkowe dla walidacji zmiennych środowiskowych
 */

const { validateEnv } = require('../../utils/validateEnv');

describe('validateEnv', () => {
  let originalEnv;

  beforeEach(() => {
    // Zapisz oryginalne zmienne środowiskowe
    originalEnv = { ...process.env };
    // Wyczyść process.env
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.MONGO_URI;
    delete process.env.FRONTEND_URL;
    delete process.env.SERVER_URL;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
  });

  afterEach(() => {
    // Przywróć oryginalne zmienne środowiskowe
    process.env = originalEnv;
  });

  it('should return errors when required vars are missing', () => {
    const result = validateEnv();

    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes('JWT_SECRET'))).toBe(true);
    expect(result.errors.some(e => e.includes('MONGO_URI'))).toBe(true);
  });

  it('should return valid when all required vars are set in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-min-32-characters-long';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';

    const result = validateEnv();

    expect(result.isValid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should return errors when production vars are missing in production', () => {
    // Ustaw NODE_ENV na production
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret-key-min-32-characters-long';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';
    // Brak FRONTEND_URL, SERVER_URL, STRIPE keys
    
    // Mock process.exit aby nie przerywać testów
    const originalExit = process.exit;
    process.exit = jest.fn();

    const result = validateEnv();

    // W produkcji powinny być błędy dla brakujących zmiennych
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes('FRONTEND_URL'))).toBe(true);
    expect(result.errors.some(e => e.includes('SERVER_URL'))).toBe(true);
    
    // Przywróć
    process.env.NODE_ENV = originalEnv;
    process.exit = originalExit;
  });

  it('should return warnings when JWT_SECRET is too short', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'short';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';

    const result = validateEnv();

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('JWT_SECRET') && w.includes('zbyt krótkie'))).toBe(true);
  });

  it('should return errors when MONGO_URI has invalid format', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-min-32-characters-long';
    process.env.MONGO_URI = 'invalid-uri';

    const result = validateEnv();

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('MONGO_URI') && e.includes('format'))).toBe(true);
  });

  it('should return warnings for recommended vars', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-min-32-characters-long';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';
    // Brak SENTRY_DSN, SMTP config

    const result = validateEnv();

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('SENTRY_DSN'))).toBe(true);
  });

  it('should validate Stripe keys format', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-min-32-characters-long';
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';
    process.env.STRIPE_SECRET_KEY = 'invalid-key';
    process.env.STRIPE_PUBLISHABLE_KEY = 'invalid-key';

    const result = validateEnv();

    expect(result.warnings.some(w => w.includes('STRIPE_SECRET_KEY'))).toBe(true);
    expect(result.warnings.some(w => w.includes('STRIPE_PUBLISHABLE_KEY'))).toBe(true);
  });
});

