/**
 * CacheService
 * Zarządza cache dla AI agentów (Redis lub memory fallback)
 */

class CacheService {
  constructor() {
    this.cache = new Map(); // Memory cache jako fallback
    this.redis = null;
    this.useRedis = false;
    this.init();
  }

  /**
   * Inicjalizacja (spróbuj połączyć z Redis jeśli dostępny)
   */
  async init() {
    try {
      // Sprawdź czy Redis jest dostępny
      if (process.env.REDIS_URL || process.env.REDIS_HOST) {
        let Redis;
        try {
          Redis = require('ioredis');
        } catch (e) {
          console.warn('ioredis not installed, using memory cache');
          this.useRedis = false;
          return;
        }
        
        this.redis = new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT || 6379,
          password: process.env.REDIS_PASSWORD || null,
          db: process.env.REDIS_DB || 0,
          retryStrategy: (times) => {
            // Retry z exponential backoff
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          maxRetriesPerRequest: 3,
          lazyConnect: true // Nie łącz od razu
        });

        this.redis.on('error', (err) => {
          console.warn('Redis connection error, using memory cache:', err.message);
          this.useRedis = false;
        });

        this.redis.on('connect', () => {
          console.log('✅ Redis connected for AI cache');
          this.useRedis = true;
        });

        // Spróbuj połączyć (nie czekamy na sukces - używamy memory cache jeśli nie działa)
        try {
          await this.redis.connect();
          await this.redis.ping();
          this.useRedis = true;
          console.log('✅ Redis connected for AI cache');
        } catch (err) {
          console.warn('Redis connection failed, using memory cache:', err.message);
          this.useRedis = false;
        }
      }
    } catch (error) {
      console.warn('Redis not available, using memory cache:', error.message);
      this.useRedis = false;
    }
  }

  /**
   * Generuj cache key
   */
  generateKey(prefix, params) {
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}:${JSON.stringify(params[key])}`)
      .join('|');
    return `ai_cache:${prefix}:${sortedParams}`;
  }

  /**
   * Pobierz z cache
   */
  async get(key) {
    try {
      if (this.useRedis && this.redis) {
        const cached = await this.redis.get(key);
        if (cached) {
          return JSON.parse(cached);
        }
      } else {
        // Memory cache
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.value;
        }
        // Wyczyść wygasłe
        this.cache.delete(key);
      }
      return null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Zapisz w cache
   */
  async set(key, value, ttlSeconds = 300) {
    try {
      if (this.useRedis && this.redis) {
        await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
      } else {
        // Memory cache (z limitem 1000 wpisów)
        if (this.cache.size > 1000) {
          // Usuń najstarsze
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        this.cache.set(key, {
          value,
          expiresAt: Date.now() + (ttlSeconds * 1000)
        });
      }
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      return false;
    }
  }

  /**
   * Usuń z cache
   */
  async delete(key) {
    try {
      if (this.useRedis && this.redis) {
        await this.redis.del(key);
      } else {
        this.cache.delete(key);
      }
      return true;
    } catch (error) {
      console.error('Cache delete error:', error);
      return false;
    }
  }

  /**
   * Pobierz lub oblicz (cache-aside pattern)
   */
  async getOrCompute(key, computeFn, ttlSeconds = 300) {
    // Spróbuj pobrać z cache
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }

    // Oblicz wartość
    const value = await computeFn();

    // Zapisz w cache
    await this.set(key, value, ttlSeconds);

    return value;
  }

  /**
   * Cache dla price hints
   */
  async getPriceHints(service, location, ttlSeconds = 3600) {
    const key = this.generateKey('price_hints', { service, location });
    return this.get(key);
  }

  async setPriceHints(service, location, priceHints, ttlSeconds = 3600) {
    const key = this.generateKey('price_hints', { service, location });
    return this.set(key, priceHints, ttlSeconds);
  }

  /**
   * Cache dla provider search
   */
  async getProviderSearch(service, location, limit, ttlSeconds = 1800) {
    const key = this.generateKey('provider_search', { service, location, limit });
    return this.get(key);
  }

  async setProviderSearch(service, location, limit, providers, ttlSeconds = 1800) {
    const key = this.generateKey('provider_search', { service, location, limit });
    return this.set(key, providers, ttlSeconds);
  }

  /**
   * Cache dla podobnych zapytań (hash message content)
   */
  async getSimilarQuery(messages, ttlSeconds = 600) {
    // Utwórz hash z ostatnich 3 wiadomości
    const lastMessages = messages.slice(-3);
    const hash = lastMessages
      .map(m => m.content?.substring(0, 100) || '')
      .join('|');
    const key = this.generateKey('similar_query', { hash });
    return this.get(key);
  }

  async setSimilarQuery(messages, response, ttlSeconds = 600) {
    const lastMessages = messages.slice(-3);
    const hash = lastMessages
      .map(m => m.content?.substring(0, 100) || '')
      .join('|');
    const key = this.generateKey('similar_query', { hash });
    return this.set(key, response, ttlSeconds);
  }

  /**
   * Wyczyść cache (dla admin)
   */
  async clear(pattern = null) {
    try {
      if (this.useRedis && this.redis) {
        if (pattern) {
          const keys = await this.redis.keys(pattern);
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        } else {
          await this.redis.flushdb();
        }
      } else {
        // Memory cache
        if (pattern) {
          // Simple pattern matching
          const regex = new RegExp(pattern.replace('*', '.*'));
          for (const key of this.cache.keys()) {
            if (regex.test(key)) {
              this.cache.delete(key);
            }
          }
        } else {
          this.cache.clear();
        }
      }
      return true;
    } catch (error) {
      console.error('Cache clear error:', error);
      return false;
    }
  }

  /**
   * Statystyki cache
   */
  async getStats() {
    try {
      if (this.useRedis && this.redis) {
        const info = await this.redis.info('stats');
        const keyspace = await this.redis.info('keyspace');
        return {
          type: 'redis',
          info: info,
          keyspace: keyspace
        };
      } else {
        return {
          type: 'memory',
          size: this.cache.size,
          maxSize: 1000
        };
      }
    } catch (error) {
      return {
        type: 'memory',
        size: this.cache.size,
        error: error.message
      };
    }
  }
}

// Singleton instance
const cacheService = new CacheService();

module.exports = cacheService;

