const User = require("../models/User");
const Verification = require("../models/Verification");

exports.isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("role");
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Wymagane uprawnienia admina" });
    }
    next();
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
};

exports.requireVerified = async (req, res, next) => {
  try {
    const v = await Verification.findOne({ user: req.user._id });
    if (!v || v.status !== "verified") {
      return res.status(403).json({ message: "Konto nie jest zweryfikowane" });
    }
    next();
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
};

exports.requireNotSuspended = async (req, res, next) => {
  try {
    const v = await Verification.findOne({ user: req.user._id });
    if (v && v.status === "suspended") {
      return res.status(403).json({ message: "Konto zawieszone" });
    }
    next();
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
};

exports.requireRole = (roles) => async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
    const allow = Array.isArray(roles) ? roles : [roles];
    // re-read fresh role from DB to avoid stale token-cache
    const fresh = await User.findById(req.user._id).select('role roleInCompany company');
    const userRole = fresh?.role || req.user.role;
    
    // Sprawdź czy rola jest dozwolona
    if (!allow.includes(userRole)) {
      return res.status(403).json({ message: 'Forbidden', role: userRole, need: allow });
    }
    
    // Dodaj informacje o firmie do request
    if (fresh.company) {
      req.userCompany = fresh.company;
      req.userRoleInCompany = fresh.roleInCompany;
    }
    
    next();
  } catch (e) {
    res.status(500).json({ message: 'Role check failed', error: e.message });
  }
};

// Middleware sprawdzające czy użytkownik jest właścicielem firmy
exports.requireCompanyOwner = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('role roleInCompany company');
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    if (user.role !== 'company_owner' && user.roleInCompany !== 'owner') {
      return res.status(403).json({ message: 'Wymagane uprawnienia właściciela firmy' });
    }
    
    req.userCompany = user.company;
    next();
  } catch (e) {
    res.status(500).json({ message: 'Company owner check failed', error: e.message });
  }
};

// Middleware sprawdzające czy użytkownik może zarządzać firmą (właściciel lub manager)
exports.requireCompanyManager = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('role roleInCompany company');
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    const canManage = user.role === 'company_owner' || 
                     user.role === 'company_manager' || 
                     user.roleInCompany === 'owner' || 
                     user.roleInCompany === 'manager';
    
    if (!canManage) {
      return res.status(403).json({ message: 'Wymagane uprawnienia do zarządzania firmą' });
    }
    
    req.userCompany = user.company;
    next();
  } catch (e) {
    res.status(500).json({ message: 'Company manager check failed', error: e.message });
  }
};

// Middleware sprawdzające czy użytkownik należy do firmy
exports.requireCompanyMember = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('role roleInCompany company');
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    if (!user.company) {
      return res.status(403).json({ message: 'Nie należysz do żadnej firmy' });
    }
    
    req.userCompany = user.company;
    next();
  } catch (e) {
    res.status(500).json({ message: 'Company member check failed', error: e.message });
  }
};
