/**
 * Testy dla Caching & Performance (Faza 2)
 */

const CacheService = require('../../services/CacheService');

describe('Phase 2: Caching & Performance', () => {
  beforeEach(async () => {
    // Wyczyść cache przed każdym testem
    await CacheService.clear('ai_cache:*');
  });

  describe('CacheService', () => {
    test('should set and get value', async () => {
      const key = 'test_key_123';
      const value = { test: 'data', number: 42 };

      await CacheService.set(key, value, 60); // 60 sekund TTL
      const retrieved = await CacheService.get(key);

      expect(retrieved).toBeDefined();
      expect(retrieved.test).toBe('data');
      expect(retrieved.number).toBe(42);
    });

    test('should return null for non-existent key', async () => {
      const retrieved = await CacheService.get('non_existent_key');
      expect(retrieved).toBeNull();
    });

    test('should delete key', async () => {
      const key = 'test_key_delete';
      await CacheService.set(key, { data: 'test' }, 60);
      
      let retrieved = await CacheService.get(key);
      expect(retrieved).toBeDefined();

      await CacheService.delete(key);
      retrieved = await CacheService.get(key);
      expect(retrieved).toBeNull();
    });

    test('should use getOrCompute pattern', async () => {
      let computeCount = 0;
      const computeFn = async () => {
        computeCount++;
        return { computed: true, count: computeCount };
      };

      // Pierwsze wywołanie - powinno obliczyć
      const result1 = await CacheService.getOrCompute('test_compute', computeFn, 60);
      expect(result1.computed).toBe(true);
      expect(computeCount).toBe(1);

      // Drugie wywołanie - powinno użyć cache
      const result2 = await CacheService.getOrCompute('test_compute', computeFn, 60);
      expect(result2.computed).toBe(true);
      expect(computeCount).toBe(1); // Nie powinno być ponownie obliczone
    });

    test('should cache price hints', async () => {
      const service = 'hydraulik';
      const location = 'Warszawa';
      const priceHints = {
        basic: { min: 100, max: 200 },
        standard: { min: 150, max: 300 }
      };

      await CacheService.setPriceHints(service, location, priceHints, 3600);
      const cached = await CacheService.getPriceHints(service, location);

      expect(cached).toBeDefined();
      expect(cached.basic.min).toBe(100);
      expect(cached.standard.min).toBe(150);
    });

    test('should cache provider search', async () => {
      const service = 'elektryk';
      const location = 'Kraków';
      const providers = [
        { id: '1', name: 'Provider 1' },
        { id: '2', name: 'Provider 2' }
      ];

      await CacheService.setProviderSearch(service, location, 5, providers, 1800);
      const cached = await CacheService.getProviderSearch(service, location, 5);

      expect(cached).toBeDefined();
      expect(Array.isArray(cached)).toBe(true);
      expect(cached.length).toBe(2);
    });

    test('should generate correct cache keys', () => {
      const key1 = CacheService.generateKey('test', { a: 1, b: 2 });
      const key2 = CacheService.generateKey('test', { b: 2, a: 1 }); // Inna kolejność
      
      expect(key1).toBe(key2); // Powinny być identyczne
      expect(key1).toContain('ai_cache:test');
    });

    test('should get stats', async () => {
      const stats = await CacheService.getStats();
      
      expect(stats).toBeDefined();
      expect(stats.type).toBeDefined(); // 'redis' lub 'memory'
      expect(['redis', 'memory']).toContain(stats.type);
    });
  });
});
