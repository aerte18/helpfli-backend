/**
 * Vercel serverless handler dla /{INDEXNOW_KEY}.txt (weryfikacja IndexNow).
 */
module.exports = async function handler(req, res) {
  try {
    const { keyFileHandler } = require('../services/IndexNowService');
    const path = String(req.url || '').split('?')[0];
    const match = path.match(/^\/([a-zA-Z0-9-]{8,128})\.txt$/i);
    req.params = { key: match ? match[1] : '' };
    return keyFileHandler(req, res);
  } catch (err) {
    console.error('[indexnow-key] handler error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('IndexNow key error');
  }
};
