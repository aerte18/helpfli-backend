const User = require('../models/User');
const Company = require('../models/Company');

// Middleware sprawdzające czy użytkownik może zarządzać firmą
exports.requireCompanyManagement = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    if (!user.canManageCompany()) {
      return res.status(403).json({ message: 'Brak uprawnień do zarządzania firmą' });
    }

    req.userCompany = user.company;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające czy użytkownik należy do firmy
exports.requireCompanyMember = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    if (!user.isInCompany()) {
      return res.status(403).json({ message: 'Nie należysz do żadnej firmy' });
    }

    req.userCompany = user.company;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające czy użytkownik jest właścicielem firmy
exports.requireCompanyOwner = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    if (!user.isCompanyOwner()) {
      return res.status(403).json({ message: 'Tylko właściciel firmy może wykonać tę akcję' });
    }

    req.userCompany = user.company;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające dostęp do konkretnej firmy
exports.requireCompanyAccess = (companyIdParam = 'companyId') => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Brak autoryzacji' });
      }

      const companyId = req.params[companyIdParam] || req.body.companyId;
      if (!companyId) {
        return res.status(400).json({ message: 'ID firmy jest wymagane' });
      }

      const user = await User.findById(req.user._id);
      if (!user) {
        return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
      }

      const company = await Company.findById(companyId);
      if (!company) {
        return res.status(404).json({ message: 'Firma nie została znaleziona' });
      }

      // Sprawdź uprawnienia
      const hasAccess = user.role === 'admin' || company.canAccess(user._id);
      if (!hasAccess) {
        return res.status(403).json({ message: 'Brak uprawnień do tej firmy' });
      }

      req.company = company;
      req.userCompany = user.company;
      req.canManageCompany = company.canManage(user._id);
      next();
    } catch (error) {
      res.status(500).json({ message: 'Błąd serwera', error: error.message });
    }
  };
};

// Middleware sprawdzające czy firma jest zweryfikowana
exports.requireVerifiedCompany = async (req, res, next) => {
  try {
    if (!req.company) {
      return res.status(400).json({ message: 'Middleware requireCompanyAccess musi być użyty wcześniej' });
    }

    if (!req.company.verified) {
      return res.status(403).json({ message: 'Firma musi być zweryfikowana' });
    }

    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające czy użytkownik może zapraszać do firmy
exports.requireInvitePermission = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    // Sprawdź czy użytkownik może zapraszać (właściciel, manager lub admin)
    const canInvite = user.role === 'admin' || user.isCompanyOwner() || user.isCompanyManager();
    
    if (!canInvite) {
      return res.status(403).json({ message: 'Brak uprawnień do zapraszania użytkowników' });
    }

    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające czy użytkownik ma aktywne zaproszenie
exports.requireActiveInvitation = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    const companyId = req.params.companyId || req.body.companyId;
    if (!companyId) {
      return res.status(400).json({ message: 'ID firmy jest wymagane' });
    }

    // Sprawdź czy użytkownik ma aktywne zaproszenie
    if (!user.companyInvitation || 
        user.companyInvitation.companyId.toString() !== companyId ||
        user.companyInvitation.status !== 'pending') {
      return res.status(400).json({ message: 'Brak aktywnego zaproszenia' });
    }

    // Sprawdź czy zaproszenie nie wygasło
    if (user.companyInvitation.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Zaproszenie wygasło' });
    }

    req.invitation = user.companyInvitation;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające limity firmy
exports.checkCompanyLimits = async (req, res, next) => {
  try {
    const companyId = req.companyId || req.params.companyId || req.body.companyId;
    if (!companyId) {
      return res.status(400).json({ message: 'ID firmy jest wymagane' });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }
    
    // Policz wszystkich członków zespołu (właściciel + managerzy + wykonawcy)
    const totalMembers = 1 + (company.managers?.length || 0) + (company.providers?.length || 0);
    
    // Pobierz plan subskrypcji firmy
    const UserSubscription = require('../models/UserSubscription');
    const SubscriptionPlan = require('../models/SubscriptionPlan');
    
    // Znajdź aktywną subskrypcję właściciela firmy
    const ownerSubscription = await UserSubscription.findOne({
      user: company.owner,
      status: 'active',
      isBusinessPlan: true
    }).lean();
    
    let maxUsers = company.settings?.maxProviders || 50; // Fallback do starego limitu
    
    if (ownerSubscription && ownerSubscription.planKey) {
      const plan = await SubscriptionPlan.findOne({ key: ownerSubscription.planKey }).lean();
      if (plan && plan.maxUsers) {
        maxUsers = plan.maxUsers;
      }
    }

    if (totalMembers >= maxUsers) {
      return res.status(403).json({ 
        message: `Firma osiągnęła limit członków zespołu (${maxUsers}). Rozważ upgrade planu.`,
        limit: maxUsers,
        current: totalMembers,
        upgradeAvailable: true
      });
    }

    next();
  } catch (error) {
    console.error('Error checking company limits:', error);
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// Middleware sprawdzające czy użytkownik może opuścić firmę
exports.canLeaveCompany = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    if (!user.isInCompany()) {
      return res.status(400).json({ message: 'Nie należysz do żadnej firmy' });
    }

    // Sprawdź czy użytkownik nie jest jedynym właścicielem
    if (user.isCompanyOwner()) {
      const company = await Company.findById(user.company);
      if (company && company.managers.length === 0) {
        return res.status(403).json({ 
          message: 'Nie możesz opuścić firmy jako jedyny właściciel. Najpierw przekaż własność lub dodaj managera.' 
        });
      }
    }

    next();
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};











