/**
 * Vercel serverless handler dla /sitemap.xml
 * (backend/vercel.json routuje ten path poza /api/*)
 */
const { connectMongoOnce } = require('../utils/mongoConnect');

module.exports = async function handler(req, res) {
  try {
    await connectMongoOnce();
    const { sitemapHandler } = require('../routes/seo');
    return sitemapHandler(req, res);
  } catch (err) {
    console.error('[sitemap] handler error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Sitemap error');
  }
};
