/**
 * Testy dla health check endpoint
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock mongoose
jest.mock('mongoose', () => ({
  connection: {
    readyState: 0,
    db: {
      stats: jest.fn()
    },
    host: 'localhost',
    port: 27017,
    name: 'helpfli'
  }
}));

// Mock axios dla AI service check
jest.mock('axios', () => ({
  get: jest.fn()
}));

// AWS v3 — health ładuje S3 tylko przy AWS_ACCESS_KEY_ID + bucket; testy tego nie ustawiają

const healthRoutes = require('../../routes/health');

describe('Health Check Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/health', healthRoutes);
    process.env.NODE_ENV = 'test';
    process.env.npm_package_version = '1.0.0';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    jest.clearAllMocks();
    
    // Reset mongoose mocks
    mongoose.connection.readyState = 0;
    mongoose.connection.db = {
      stats: jest.fn()
    };
    
    // Reset axios mock
    const axios = require('axios');
    axios.get = jest.fn().mockResolvedValue({
      data: { models: [] }
    });
  });

  describe('GET /api/health', () => {
    it('should return 200 with basic health info', async () => {
      mongoose.connection.readyState = 1; // Connected
      const axios = require('axios');
      axios.get = jest.fn().mockResolvedValue({
        data: { models: [] }
      });

      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('environment');
      expect(response.body).toHaveProperty('services');
      expect(response.body.services).toHaveProperty('database');
    });

    it('should return degraded status when database is disconnected', async () => {
      mongoose.connection.readyState = 0; // Disconnected

      const response = await request(app)
        .get('/api/health')
        .expect(503);

      expect(response.body.status).toBe('degraded');
      expect(response.body.services.database).toBe('disconnected');
    });

    it('should handle Vercel environment', async () => {
      process.env.VERCEL = '1';

      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body.platform).toBe('vercel');
      expect(response.body.ok).toBe(true);

      delete process.env.VERCEL;
    });

    it('should return error status on exception', async () => {
      mongoose.connection.readyState = 1;
      // Force an error by making axios throw
      const axios = require('axios');
      axios.get = jest.fn().mockRejectedValue(new Error('Network error'));

      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.services.ai).toBe('unavailable');
    });
  });

  describe('GET /api/health/detailed', () => {
    it('should return detailed health info', async () => {
      mongoose.connection.readyState = 1;
      mongoose.connection.db.stats = jest.fn().mockResolvedValue({
        collections: 10,
        dataSize: 1024,
        indexSize: 512
      });
      
      // Mock axios for AI service check
      const axios = require('axios');
      axios.get = jest.fn().mockResolvedValue({
        data: { models: [{ name: 'test-model' }] }
      });

      const response = await request(app)
        .get('/api/health/detailed')
        .expect(200);

      expect(response.body).toHaveProperty('memory');
      expect(response.body).toHaveProperty('cpu');
      expect(response.body.services.database).toHaveProperty('status');
      expect(response.body.services.database.status).toBe('connected');
    });

    it('should return degraded status when database is disconnected', async () => {
      mongoose.connection.readyState = 0;

      const response = await request(app)
        .get('/api/health/detailed')
        .expect(503);

      expect(response.body.status).toBe('degraded');
      expect(response.body.services.database.status).toBe('disconnected');
    });
  });
});

