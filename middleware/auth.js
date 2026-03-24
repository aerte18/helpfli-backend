const jwt = require("jsonwebtoken");

exports.getUserFromToken = (req) => {
  try {
    const authHeader = req.headers.authorization || ""; // "Bearer <token>"
    const token = authHeader.split(" ")[1];
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.id || null;
  } catch (e) {
    return null;
  }
};

// Middleware sprawdzające autoryzację z obsługą ról firmowych
exports.auth = async (req, res, next) => {
  try {
    const userId = exports.getUserFromToken(req);
    if (!userId) {
      return res.status(401).json({ message: "Brak autoryzacji" });
    }

    const User = require('../models/User');
    const user = await User.findById(userId).select('_id name email role roleInCompany company isActive');
    
    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Nieprawidłowy token" });
    }

    req.user = user;
    req.userId = userId;
    
    // Dodaj informacje o firmie jeśli użytkownik należy do firmy
    if (user.company) {
      req.userCompany = user.company;
      req.userRoleInCompany = user.roleInCompany;
    }
    
    next();
  } catch (error) {
    res.status(401).json({ message: "Błąd autoryzacji", error: error.message });
  }
};












