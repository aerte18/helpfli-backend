module.exports = async function handler(req, res) {
  const mask = (v) => (typeof v === 'string' && v.length > 0 ? true : false);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).end(
    JSON.stringify({
      ok: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || null,
        VERCEL: process.env.VERCEL || null,
        CORS_ORIGIN: process.env.CORS_ORIGIN || null,
        JWT_SECRET_present: mask(process.env.JWT_SECRET),
        MONGODB_URI_present: mask(process.env.MONGODB_URI || process.env.MONGO_URI),
      },
    })
  );
};




