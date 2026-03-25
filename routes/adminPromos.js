const express = require('express');
const router = express.Router();
const PromoCode = require('../models/PromoCode');
const { authMiddleware: auth } = require('../middleware/authMiddleware');

function isAdmin(user){
  return user && (user.role === 'admin' || (user.email && user.email.endsWith('@helpfli.dev')));
}

router.post('/', auth, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Tylko admin' });
    const payload = { ...req.body };
    payload.code = String(payload.code || '').toUpperCase().trim();
    const created = await PromoCode.create(payload);
    res.json(created);
  } catch (e) {
    console.error(e);
    res.status(400).json({ message: 'Błąd tworzenia kodu', error: e.message });
  }
});

module.exports = router;






