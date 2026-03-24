module.exports = function requireAdmin(req, res, next) {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Tylko dla administratorów.' });
    }
    next();
  } catch (e) { 
    next(e); 
  }
};























