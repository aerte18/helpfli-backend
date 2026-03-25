const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// Health check endpoint
router.get('/', async (req, res) => {
  // On Vercel Functions keep health very lightweight to avoid timeouts/crashes
  if (process.env.VERCEL === '1') {
    return res.status(200).json({ ok: true, platform: 'vercel', ts: new Date().toISOString() });
  }
  const isProd = (process.env.NODE_ENV || 'development') === 'production';
  const strictStorageHealth = process.env.HEALTH_STRICT_STORAGE === '1';
  const healthCheck = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '1.0.0',
    services: {
      database: 'unknown',
      ai: 'unknown',
      storage: 'unknown'
    }
  };

  try {
    // Check MongoDB connection
    if (mongoose.connection.readyState === 1) {
      healthCheck.services.database = 'connected';
    } else {
      healthCheck.services.database = 'disconnected';
      healthCheck.status = 'degraded';
    }

    // Check AI service (Ollama) - optional, nie blokuj jeśli nie działa
    try {
      const axios = require('axios');
      const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
      await axios.get(`${ollamaUrl}/api/tags`, { timeout: 2000 });
      healthCheck.services.ai = 'available';
    } catch (error) {
      healthCheck.services.ai = 'unavailable';
      // Nie zmieniaj statusu na degraded jeśli AI nie działa - to opcjonalna funkcja
      // healthCheck.status = 'degraded';
    }

    // Check storage (S3) — bucket name może być w AWS_S3_BUCKET lub AWS_BUCKET_NAME (upload używa drugiego)
    const s3Bucket = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME;
    if (process.env.AWS_ACCESS_KEY_ID && s3Bucket) {
      try {
        const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({
          region: process.env.AWS_REGION || 'eu-central-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
          }
        });
        await s3.send(new HeadBucketCommand({ Bucket: s3Bucket }));
        healthCheck.services.storage = 'available';
      } catch (error) {
        healthCheck.services.storage = 'unavailable';
        if (isProd || strictStorageHealth) healthCheck.status = 'degraded';
      }
    } else if (process.env.AWS_ACCESS_KEY_ID && !s3Bucket) {
      healthCheck.services.storage = 'misconfigured';
      if (isProd || strictStorageHealth) healthCheck.status = 'degraded';
    } else {
      healthCheck.services.storage = 'local';
    }

    // Determine overall status
    const statusCode = healthCheck.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(healthCheck);

  } catch (error) {
    healthCheck.status = 'error';
    healthCheck.error = error.message;
    res.status(503).json(healthCheck);
  }
});

// Detailed health check with more info
router.get('/detailed', async (req, res) => {
  const detailedHealth = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '1.0.0',
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    services: {
      database: {},
      ai: {},
      storage: {}
    }
  };

  try {
    // MongoDB detailed check
    if (mongoose.connection.readyState === 1) {
      const dbStats = await mongoose.connection.db.stats();
      detailedHealth.services.database = {
        status: 'connected',
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        name: mongoose.connection.name,
        collections: dbStats.collections,
        dataSize: dbStats.dataSize,
        indexSize: dbStats.indexSize
      };
    } else {
      detailedHealth.services.database = {
        status: 'disconnected',
        readyState: mongoose.connection.readyState
      };
      detailedHealth.status = 'degraded';
    }

    // AI service detailed check
    try {
      const axios = require('axios');
      const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
      const response = await axios.get(`${ollamaUrl}/api/tags`, { timeout: 5000 });
      detailedHealth.services.ai = {
        status: 'available',
        models: response.data.models?.length || 0,
        currentModel: process.env.OLLAMA_MODEL || 'unknown'
      };
    } catch (error) {
      detailedHealth.services.ai = {
        status: 'unavailable',
        error: error.message
      };
      detailedHealth.status = 'degraded';
    }

    const statusCode = detailedHealth.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(detailedHealth);

  } catch (error) {
    detailedHealth.status = 'error';
    detailedHealth.error = error.message;
    res.status(503).json(detailedHealth);
  }
});

module.exports = router;
