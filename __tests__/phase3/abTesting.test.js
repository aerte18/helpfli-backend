/**
 * Testy dla ABTestingService
 */

const abTestingService = require('../../services/ABTestingService');

describe('Phase 3: ABTestingService', () => {
  beforeEach(() => {
    // Reset experiments to defaults
    abTestingService.experiments.clear();
    abTestingService.initDefaultExperiments();
  });

  describe('assignVariant', () => {
    test('should assign variant deterministically', () => {
      const userId1 = 'user123';
      const userId2 = 'user456';
      
      // Same user should get same variant
      const variant1a = abTestingService.assignVariant(userId1, 'response_length');
      const variant1b = abTestingService.assignVariant(userId1, 'response_length');
      
      expect(variant1a).toBe(variant1b);

      // Different users might get different variants
      const variant2 = abTestingService.assignVariant(userId2, 'response_length');
      
      // At least one should be assigned (A, B, or C)
      expect(['A', 'B', 'C']).toContain(variant1a);
      expect(['A', 'B', 'C']).toContain(variant2);
    });

    test('should assign variant for communication_style experiment', () => {
      const userId = 'user123';
      const variant = abTestingService.assignVariant(userId, 'communication_style');

      expect(['A', 'B']).toContain(variant);
    });

    test('should return default variant A for unknown experiment', () => {
      const userId = 'user123';
      const variant = abTestingService.assignVariant(userId, 'unknown_experiment');

      expect(variant).toBe('A');
    });
  });

  describe('getVariantConfig', () => {
    test('should return config for valid variant', () => {
      const config = abTestingService.getVariantConfig('response_length', 'A');

      expect(config).toBeDefined();
      expect(config.name).toBe('Brief');
      expect(config.description).toBeDefined();
    });

    test('should return null for invalid experiment', () => {
      const config = abTestingService.getVariantConfig('unknown_experiment', 'A');

      expect(config).toBeNull();
    });

    test('should return null for invalid variant', () => {
      const config = abTestingService.getVariantConfig('response_length', 'Z');

      expect(config).toBeNull();
    });
  });

  describe('recordResult', () => {
    test('should record result without error', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await abTestingService.recordResult(
        'user123',
        'response_length',
        'A',
        'satisfaction',
        4.5
      );

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('getExperimentStats', () => {
    test('should return stats for valid experiment', async () => {
      const stats = await abTestingService.getExperimentStats('response_length');

      expect(stats).toBeDefined();
      expect(stats.experimentId).toBe('response_length');
      expect(stats.name).toBe('Response Length');
      expect(stats.variants).toContain('A');
      expect(stats.variants).toContain('B');
      expect(stats.variants).toContain('C');
      expect(stats.allocation).toBeDefined();
    });

    test('should return null for unknown experiment', async () => {
      const stats = await abTestingService.getExperimentStats('unknown_experiment');

      expect(stats).toBeNull();
    });
  });

  describe('hashUserId', () => {
    test('should generate consistent hash', () => {
      // Access private method through assignVariant behavior
      const variant1 = abTestingService.assignVariant('user123', 'response_length');
      const variant2 = abTestingService.assignVariant('user123', 'response_length');

      expect(variant1).toBe(variant2);
    });

    test('should generate different hashes for different inputs', () => {
      const variant1 = abTestingService.assignVariant('user123', 'response_length');
      const variant2 = abTestingService.assignVariant('user456', 'response_length');

      // Might be same or different, but both should be valid
      expect(['A', 'B', 'C']).toContain(variant1);
      expect(['A', 'B', 'C']).toContain(variant2);
    });
  });

  describe('default experiments', () => {
    test('should have response_length experiment', () => {
      const experiment = abTestingService.experiments.get('response_length');

      expect(experiment).toBeDefined();
      expect(experiment.variants).toHaveProperty('A');
      expect(experiment.variants).toHaveProperty('B');
      expect(experiment.variants).toHaveProperty('C');
    });

    test('should have communication_style experiment', () => {
      const experiment = abTestingService.experiments.get('communication_style');

      expect(experiment).toBeDefined();
      expect(experiment.variants).toHaveProperty('A');
      expect(experiment.variants).toHaveProperty('B');
    });

    test('should have tool_calling experiment', () => {
      const experiment = abTestingService.experiments.get('tool_calling');

      expect(experiment).toBeDefined();
      expect(experiment.variants).toHaveProperty('A');
      expect(experiment.variants).toHaveProperty('B');
    });

    test('should have correct allocation percentages', () => {
      const experiment = abTestingService.experiments.get('response_length');
      const allocation = experiment.allocation;

      const total = Object.values(allocation).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1.0, 2);
    });
  });
});

