/**
 * Testy dla Error Recovery & Resilience (Faza 2)
 */

const ErrorRecoveryService = require('../../services/ErrorRecoveryService');

describe('Phase 2: Error Recovery & Resilience', () => {
  describe('ErrorRecoveryService', () => {
    describe('Retry Logic', () => {
      test('should retry on failure', async () => {
        let attemptCount = 0;
        const fn = async () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw new Error('Temporary error');
          }
          return 'success';
        };

        const result = await ErrorRecoveryService.retry(fn, {
          maxRetries: 3,
          shouldRetry: () => true
        });

        expect(result).toBe('success');
        expect(attemptCount).toBe(3);
      }, 10000);

      test('should not retry on non-retryable error', async () => {
        let attemptCount = 0;
        const fn = async () => {
          attemptCount++;
          throw new Error('Permanent error');
        };

        await expect(
          ErrorRecoveryService.retry(fn, {
            maxRetries: 3,
            shouldRetry: (error) => error.message.includes('Temporary')
          })
        ).rejects.toThrow('Permanent error');

        expect(attemptCount).toBe(1); // Tylko jedna próba
      });

      test('should use exponential backoff', async () => {
        const delays = [];
        const fn = async () => {
          throw new Error('timeout');
        };

        const startTime = Date.now();
        try {
          await ErrorRecoveryService.retry(fn, {
            maxRetries: 2,
            baseDelay: 100,
            shouldRetry: () => true,
            onRetry: (error, attempt, delay) => {
              delays.push(delay);
            }
          });
        } catch (e) {
          // Expected to fail
        }

        const totalTime = Date.now() - startTime;
        // Powinno być opóźnienie między próbami
        expect(totalTime).toBeGreaterThan(100);
        expect(delays.length).toBeGreaterThan(0);
      }, 5000);
    });

    describe('Circuit Breaker', () => {
      beforeEach(() => {
        // Reset circuit breaker przed każdym testem
        ErrorRecoveryService.resetCircuitBreaker('test_service');
      });

      test('should allow execution when circuit is closed', async () => {
        const fn = async () => 'success';
        
        const result = await ErrorRecoveryService.executeWithCircuitBreaker(
          'test_service',
          fn
        );

        expect(result).toBe('success');
      });

      test('should open circuit after threshold failures', async () => {
        const breaker = ErrorRecoveryService.getCircuitBreaker('test_service');
        breaker.threshold = 3; // Zmniejsz próg dla testu

        // Wywołaj 3 razy z błędem
        for (let i = 0; i < 3; i++) {
          try {
            await ErrorRecoveryService.executeWithCircuitBreaker(
              'test_service',
              async () => {
                throw new Error('Service error');
              }
            );
          } catch (e) {
            // Expected
          }
        }

        // Circuit powinien być otwarty
        expect(breaker.state).toBe('open');

        // Kolejne wywołanie powinno rzucić błąd
        await expect(
          ErrorRecoveryService.executeWithCircuitBreaker(
            'test_service',
            async () => 'should not execute'
          )
        ).rejects.toThrow('Circuit breaker is OPEN');
      }, 10000);

      test('should transition to half-open after timeout', async () => {
        const breaker = ErrorRecoveryService.getCircuitBreaker('test_service');
        breaker.threshold = 1;
        breaker.timeout = 1000; // 1 sekunda timeout

        // Otwórz circuit breaker
        breaker.state = 'open';
        breaker.lastFailureTime = Date.now() - 2000; // 2 sekundy temu

        // Powinien być w stanie half-open lub closed
        const fn = async () => 'success';
        const result = await ErrorRecoveryService.executeWithCircuitBreaker(
          'test_service',
          fn
        );

        expect(result).toBe('success');
      });

      test('should get circuit breaker status', () => {
        const status = ErrorRecoveryService.getCircuitBreakerStatus();
        expect(status).toBeDefined();
        expect(typeof status).toBe('object');
      });
    });

    describe('Fallback Pattern', () => {
      test('should use fallback on primary failure', async () => {
        const primaryFn = async () => {
          throw new Error('Primary failed');
        };
        const fallbackFn = async (error) => {
          return { success: true, from: 'fallback', error: error.message };
        };

        const result = await ErrorRecoveryService.executeWithFallback(
          primaryFn,
          fallbackFn
        );

        expect(result.success).toBe(true);
        expect(result.from).toBe('fallback');
      });

      test('should use primary if it succeeds', async () => {
        const primaryFn = async () => {
          return { success: true, from: 'primary' };
        };
        const fallbackFn = async () => {
          return { success: true, from: 'fallback' };
        };

        const result = await ErrorRecoveryService.executeWithFallback(
          primaryFn,
          fallbackFn
        );

        expect(result.from).toBe('primary');
      });
    });
  });
});
