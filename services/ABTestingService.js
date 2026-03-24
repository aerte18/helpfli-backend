/**
 * ABTestingService
 * Framework do A/B testowania różnych wersji promptów i strategii AI
 */

class ABTestingService {
  constructor() {
    this.experiments = new Map();
    this.initDefaultExperiments();
  }

  /**
   * Inicjalizuj domyślne eksperymenty
   */
  initDefaultExperiments() {
    // Eksperyment 1: Długość odpowiedzi
    this.experiments.set('response_length', {
      name: 'Response Length',
      variants: {
        A: { name: 'Brief', description: 'Krótkie odpowiedzi (1-2 zdania)' },
        B: { name: 'Standard', description: 'Standardowe odpowiedzi (3-5 zdań)' },
        C: { name: 'Detailed', description: 'Szczegółowe odpowiedzi (5+ zdań)' }
      },
      allocation: { A: 0.33, B: 0.34, C: 0.33 }
    });

    // Eksperyment 2: Styl komunikacji
    this.experiments.set('communication_style', {
      name: 'Communication Style',
      variants: {
        A: { name: 'Formal', description: 'Formalny język' },
        B: { name: 'Casual', description: 'Swobodny język' }
      },
      allocation: { A: 0.5, B: 0.5 }
    });

    // Eksperyment 3: Tool calling frequency
    this.experiments.set('tool_calling', {
      name: 'Tool Calling',
      variants: {
        A: { name: 'Aggressive', description: 'Częste użycie narzędzi' },
        B: { name: 'Conservative', description: 'Ostrożne użycie narzędzi' }
      },
      allocation: { A: 0.5, B: 0.5 }
    });
  }

  /**
   * Przypisz użytkownika do wariantu eksperymentu
   */
  assignVariant(userId, experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      return 'A'; // Default variant
    }

    // Użyj userId do deterministycznego przypisania
    const hash = this.hashUserId(userId, experimentId);
    const random = hash % 100 / 100;

    let cumulative = 0;
    for (const [variant, allocation] of Object.entries(experiment.allocation)) {
      cumulative += allocation;
      if (random < cumulative) {
        return variant;
      }
    }

    return 'A'; // Fallback
  }

  /**
   * Hash userId dla deterministycznego przypisania
   */
  hashUserId(userId, experimentId) {
    const str = `${userId}_${experimentId}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Pobierz konfigurację wariantu
   */
  getVariantConfig(experimentId, variant) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment || !experiment.variants[variant]) {
      return null;
    }

    return experiment.variants[variant];
  }

  /**
   * Zarejestruj wynik eksperymentu
   */
  async recordResult(userId, experimentId, variant, metric, value) {
    // W przyszłości można zapisywać do bazy danych
    // Na razie tylko logujemy
    console.log(`A/B Test: ${experimentId} variant ${variant} - ${metric}: ${value} (user: ${userId})`);
  }

  /**
   * Pobierz statystyki eksperymentu
   */
  async getExperimentStats(experimentId) {
    // W przyszłości można agregować z bazy danych
    // Na razie zwracamy strukturę
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      return null;
    }

    return {
      experimentId,
      name: experiment.name,
      variants: Object.keys(experiment.variants),
      allocation: experiment.allocation
    };
  }
}

// Singleton instance
const abTestingService = new ABTestingService();

module.exports = abTestingService;

