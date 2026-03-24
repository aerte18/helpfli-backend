module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).end(JSON.stringify({ ok: true, env: process.env.NODE_ENV || 'production', ts: new Date().toISOString() }));
};




