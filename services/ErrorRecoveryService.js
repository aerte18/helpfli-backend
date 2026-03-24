/**
 * ErrorRecoveryService
 * Zarządza retry logic, circuit breaker i graceful degradation
 */

class ErrorRecoveryService {
  constructor() {
    this.circuitBreakers = new Map(); // Circuit breakers per service
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 100, // ms
      maxDelay: 5000, // ms
      backoffFactor: 2
    };
  }

  /**
   * Exponential backoff delay
   */
  getDelay(retryAttempt) {
    const delay = Math.min(
      this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, retryAttempt),
      this.retryConfig.maxDelay
    );
    // Dodaj losowość żeby uniknąć thundering herd
    return delay + Math.random() * 100;
  }

  /**
   * Retry z exponential backoff
   */
  async retry(fn, options = {}) {
    const {
      maxRetries = this.retryConfig.maxRetries,
      onRetry = null,
      shouldRetry = (error) => {
        // Retry dla timeout, network errors, rate limits
        return error.message?.includes('timeout') ||
               error.message?.includes('ECONNREFUSED') ||
               error.message?.includes('ETIMEDOUT') ||
               error.message?.includes('rate limit') ||
               error.status === 429 ||
               error.status === 503;
      }
    } = options;

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Sprawdź czy powinno retry
        if (attempt < maxRetries && shouldRetry(error)) {
          const delay = this.getDelay(attempt);
          console.log(`⚠️ Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms:`, error.message);

          if (onRetry) {
            await onRetry(error, attempt, delay);
          }

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Nie retry lub wyczerpane próby
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Circuit Breaker pattern
   */
  getCircuitBreaker(serviceName) {
    if (!this.circuitBreakers.has(serviceName)) {
      this.circuitBreakers.set(serviceName, {
        state: 'closed', // closed, open, half-open
        failureCount: 0,
        successCount: 0,
        lastFailureTime: null,
        threshold: 5, // Próg błędów przed otwarciem
        timeout: 60000, // 60s timeout przed próbą zamknięcia
        halfOpenMaxRequests: 3 // Max requestów w stanie half-open
      });
    }
    return this.circuitBreakers.get(serviceName);
  }

  /**
   * Wykonaj funkcję z circuit breaker
   */
  async executeWithCircuitBreaker(serviceName, fn) {
    const breaker = this.getCircuitBreaker(serviceName);

    // Sprawdź stan circuit breaker
    if (breaker.state === 'open') {
      // Sprawdź czy minął timeout
      if (Date.now() - breaker.lastFailureTime < breaker.timeout) {
        throw new Error(`Circuit breaker is OPEN for ${serviceName}. Service unavailable.`);
      }
      // Przejdź do half-open
      breaker.state = 'half-open';
      breaker.successCount = 0;
    }

    try {
      const result = await fn();

      // Sukces - zaktualizuj circuit breaker
      if (breaker.state === 'half-open') {
        breaker.successCount++;
        if (breaker.successCount >= breaker.halfOpenMaxRequests) {
          // Zamknij circuit breaker
          breaker.state = 'closed';
          breaker.failureCount = 0;
          console.log(`✅ Circuit breaker CLOSED for ${serviceName}`);
        }
      } else if (breaker.state === 'closed') {
        breaker.failureCount = 0; // Reset na sukces
      }

      return result;

    } catch (error) {
      // Błąd - zaktualizuj circuit breaker
      breaker.failureCount++;
      breaker.lastFailureTime = Date.now();

      if (breaker.state === 'half-open') {
        // W half-open jeden błąd = otwórz ponownie
        breaker.state = 'open';
        console.log(`❌ Circuit breaker OPENED for ${serviceName} (half-open failure)`);
      } else if (breaker.state === 'closed' && breaker.failureCount >= breaker.threshold) {
        // Próg błędów osiągnięty - otwórz circuit breaker
        breaker.state = 'open';
        console.log(`❌ Circuit breaker OPENED for ${serviceName} (threshold reached)`);
      }

      throw error;
    }
  }

  /**
   * Graceful degradation - wykonaj z fallbackiem
   */
  async executeWithFallback(primaryFn, fallbackFn, options = {}) {
    const {
      enableCircuitBreaker = false,
      serviceName = 'default',
      enableRetry = true
    } = options;

    try {
      let fn = primaryFn;

      // Dodaj retry jeśli włączone
      if (enableRetry) {
        fn = () => this.retry(primaryFn, options.retryOptions);
      }

      // Dodaj circuit breaker jeśli włączony
      if (enableCircuitBreaker) {
        fn = () => this.executeWithCircuitBreaker(serviceName, primaryFn);
      }

      return await fn();

    } catch (error) {
      console.warn(`⚠️ Primary function failed, using fallback:`, error.message);

      // Użyj fallback
      try {
        if (fallbackFn) {
          return await fallbackFn(error);
        }
      } catch (fallbackError) {
        console.error('❌ Fallback also failed:', fallbackError);
        throw fallbackError;
      }

      // Jeśli brak fallback, rzuć oryginalny błąd
      throw error;
    }
  }

  /**
   * Reset circuit breaker (dla admin)
   */
  resetCircuitBreaker(serviceName) {
    if (this.circuitBreakers.has(serviceName)) {
      const breaker = this.circuitBreakers.get(serviceName);
      breaker.state = 'closed';
      breaker.failureCount = 0;
      breaker.successCount = 0;
      breaker.lastFailureTime = null;
      console.log(`🔄 Circuit breaker RESET for ${serviceName}`);
    }
  }

  /**
   * Pobierz status circuit breakers
   */
  getCircuitBreakerStatus() {
    const status = {};
    for (const [serviceName, breaker] of this.circuitBreakers.entries()) {
      status[serviceName] = {
        state: breaker.state,
        failureCount: breaker.failureCount,
        successCount: breaker.successCount,
        lastFailureTime: breaker.lastFailureTime
      };
    }
    return status;
  }
}

// Singleton instance
const errorRecoveryService = new ErrorRecoveryService();

module.exports = errorRecoveryService;

