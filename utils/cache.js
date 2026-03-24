// Prosty cache in-memory dla często używanych danych
// W produkcji można zastąpić Redis

class SimpleCache {
  constructor(defaultTTL = 3600000) { // 1 godzina domyślnie
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
  }

  /**
   * Pobiera wartość z cache
   * @param {String} key - Klucz cache
   * @returns {*} Wartość lub null jeśli nie istnieje/wygasła
   */
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    // Sprawdź czy nie wygasł
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  /**
   * Zapisuje wartość do cache
   * @param {String} key - Klucz cache
   * @param {*} value - Wartość do zapisania
   * @param {Number} ttl - Czas życia w ms (opcjonalne)
   */
  set(key, value, ttl = null) {
    const expiresAt = ttl ? Date.now() + ttl : Date.now() + this.defaultTTL;
    this.cache.set(key, { value, expiresAt, createdAt: Date.now() });
  }

  /**
   * Usuwa wartość z cache
   * @param {String} key - Klucz cache
   */
  delete(key) {
    this.cache.delete(key);
  }

  /**
   * Czyści cały cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Usuwa wygasłe wpisy
   */
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (item.expiresAt && item.expiresAt < now) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Pobiera statystyki cache
   */
  getStats() {
    this.cleanup();
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}

// Singleton instance
const cache = new SimpleCache();

// Automatyczne czyszczenie co 10 minut
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    cache.cleanup();
  }, 10 * 60 * 1000);
}

module.exports = cache;
