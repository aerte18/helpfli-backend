const mongoose = require('mongoose');

module.exports = async function handler(req, res) {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  const start = Date.now();
  try {
    if (!uri) throw new Error('Missing MONGODB_URI');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });
    const elapsed = Date.now() - start;
    return res.status(200).json({ ok: true, elapsedMs: elapsed, host: mongoose.connection?.host, db: mongoose.connection?.name });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err?.message || String(err) });
  } finally {
    try { await mongoose.connection?.close(); } catch {}
  }
};




