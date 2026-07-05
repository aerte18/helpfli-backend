const mongoose = require('mongoose');

function resolveMongoUri() {
  return process.env.MONGO_URI || process.env.MONGODB_URI || '';
}

function isLocalMongoUri(uri) {
  return !uri || /localhost|127\.0\.0\.1/.test(uri);
}

/**
 * Lightweight Mongo readiness probe for health endpoints (incl. Vercel serverless).
 */
async function getMongoHealthStatus({ timeoutMs = 2500 } = {}) {
  if (mongoose.connection.readyState === 1) {
    return { database: 'connected', status: 'ok' };
  }

  const mongoUri = resolveMongoUri();
  if (isLocalMongoUri(mongoUri)) {
    return { database: 'skipped', status: 'ok', reason: 'no_remote_uri' };
  }

  try {
    if (mongoose.connection.readyState === 2) {
      await Promise.race([
        mongoose.connection.asPromise(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Mongo connect timeout')), timeoutMs)
        ),
      ]);
    } else if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
        maxPoolSize: 1,
      });
    }

    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return { database: 'disconnected', status: 'degraded' };
    }

    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Mongo ping timeout')), timeoutMs)
      ),
    ]);

    return { database: 'connected', status: 'ok' };
  } catch (error) {
    return {
      database: 'disconnected',
      status: 'degraded',
      error: error.message,
    };
  }
}

module.exports = {
  getMongoHealthStatus,
  resolveMongoUri,
  isLocalMongoUri,
};
