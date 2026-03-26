// Vercel serverless handler delegating to Express app
const app = require('../server');
const { connectMongo } = require('../server');

module.exports = async function handler(req, res) {
  // Global CORS for serverless edge
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Pragma, Expires'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  // ultra-light health endpoint, never touches DB
  if (req.url && (req.url === '/api/health' || req.url === '/health' || req.url.includes('health'))) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(JSON.stringify({ ok: true, platform: 'vercel', ts: new Date().toISOString() }));
  }
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
    if (process.env.VERCEL === '1' && (!mongoUri || /localhost|127\.0\.0\.1/.test(mongoUri))) {
      // skip DB connect on Vercel without remote URI
    } else {
      await connectMongo();
    }
  } catch (e) {
    // continue without DB
  }
  return app(req, res);
};


