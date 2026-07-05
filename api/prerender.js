/**
 * Vercel serverless handler dla GET /api/seo/prerender (publiczny, bez JWT).
 */
const { connectMongoOnce } = require('../utils/mongoConnect');

function parseQuery(url = '') {
  const q = {};
  const i = url.indexOf('?');
  if (i === -1) return q;
  for (const part of url.slice(i + 1).split('&')) {
    const [k, v = ''] = part.split('=');
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return q;
}

module.exports = async function handler(req, res) {
  try {
    await connectMongoOnce();
    const { prerenderHandler } = require('../services/SeoPrerenderService');
    req.query = { ...parseQuery(req.url), ...(req.query || {}) };
    return prerenderHandler(req, res);
  } catch (err) {
    console.error('[prerender] handler error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Prerender error');
  }
};
