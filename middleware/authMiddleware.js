const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ message: 'Brak tokenu' });

  try {
    const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password').populate('services', 'name');
    if (!req.user) throw new Error();
    
    // Aktualizuj lastSeenAt przy każdym żądaniu (tylko dla providerów)
    if (req.user.role === 'provider') {
      await User.findByIdAndUpdate(req.user._id, {
        'provider_status.lastSeenAt': new Date()
      });
    }
    
    next();
  } catch (err) {
    res.status(401).json({ message: 'Nieautoryzowany dostęp' });
  }
};

const getUserFromToken = (req) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.split(" ")[1];
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.id || null;
  } catch (e) {
    return null;
  }
};

const verifyToken = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ message: 'Brak tokenu' });

  try {
    const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Nieautoryzowany dostęp' });
  }
};

module.exports = { authMiddleware, getUserFromToken, verifyToken };