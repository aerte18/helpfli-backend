/**
 * Vercel serverless handler dla /robots.txt
 */
module.exports = async function handler(_req, res) {
  try {
    const { robotsHandler } = require('../routes/seo');
    return robotsHandler(_req, res);
  } catch (err) {
    console.error('[robots] handler error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Robots error');
  }
};
