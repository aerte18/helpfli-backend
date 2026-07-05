const mongoose = require('mongoose');

let mongoConnectionPromise = null;

/**
 * Lekkie połączenie z MongoDB dla serverless (sitemap, cron) — bez ładowania całego server.js.
 */
async function connectMongoOnce() {
  if (mongoose.connection?.readyState === 1) return true;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  if (!uri || uri === 'undefined') return false;
  if (process.env.VERCEL === '1' && /localhost|127\.0\.0\.1/.test(uri)) return false;

  if (!mongoConnectionPromise) {
    mongoConnectionPromise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 5
      })
      .then(() => true)
      .catch((err) => {
        mongoConnectionPromise = null;
        console.error('[mongoConnect] failed:', err?.message || err);
        return false;
      });
  }

  return mongoConnectionPromise;
}

module.exports = { connectMongoOnce };
