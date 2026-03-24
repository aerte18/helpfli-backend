const CompanyRole = require('../models/CompanyRole');
const Company = require('../models/Company');
const User = require('../models/User');
const CompanyAuditLog = require('../models/CompanyAuditLog');

/**
 * Pobiera rolę użytkownika w firmie
 * @param {String} userId - ID użytkownika
 * @param {String} companyId - ID firmy
 * @returns {Object} { role: CompanyRole, isOwner: Boolean, isManager: Boolean }
 */
async function getUserCompanyRole(userId, companyId) {
  try {
    const user = await User.findById(userId);
    const company = await Company.findById(companyId);
    
    if (!user || !company) {
      return null;
    }
    
    // Sprawdź czy użytkownik jest właścicielem
    if (company.owner.toString() === userId.toString()) {
      return {
        role: null, // Owner ma wszystkie uprawnienia
        isOwner: true,
        isManager: true,
        roleName: 'Owner'
      };
    }
    
    // Sprawdź czy użytkownik jest managerem
    const isManager = company.managers.some(m => m.toString() === userId.toString());
    
    // Sprawdź czy użytkownik ma custom role
    if (user.companyRoleId) {
      const customRole = await CompanyRole.findById(user.companyRoleId);
      if (customRole && customRole.company.toString() === companyId.toString() && customRole.isActive) {
        return {
          role: customRole,
          isOwner: false,
          isManager: isManager,
          roleName: customRole.name
        };
      }
    }
    
    // Domyślna rola na podstawie roleInCompany
    return {
      role: null,
      isOwner: false,
      isManager: isManager,
      roleName: user.roleInCompany || 'provider'
    };
  } catch (error) {
    console.error('Error getting user company role:', error);
    return null;
  }
}

/**
 * Sprawdza czy użytkownik ma uprawnienie do wykonania akcji
 * @param {String} userId - ID użytkownika
 * @param {String} companyId - ID firmy
 * @param {String} action - Akcja do sprawdzenia (np. 'orders.assign', 'finances.withdraw')
 * @param {Object} context - Kontekst akcji (np. { amount: 1000 })
 * @returns {Object} { allowed: Boolean, requiresApproval: Boolean, reason: String }
 */
async function checkPermission(userId, companyId, action, context = {}) {
  try {
    const userRole = await getUserCompanyRole(userId, companyId);
    
    if (!userRole) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Użytkownik nie należy do firmy'
      };
    }
    
    // Owner ma wszystkie uprawnienia
    if (userRole.isOwner) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: 'Owner ma wszystkie uprawnienia'
      };
    }
    
    // Jeśli użytkownik ma custom role, sprawdź uprawnienia roli
    if (userRole.role) {
      const canPerform = await userRole.role.canPerformAction(action, context);
      
      if (typeof canPerform === 'object') {
        return canPerform;
      }
      
      if (canPerform === false) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'Brak uprawnień w roli'
        };
      }
      
      return {
        allowed: true,
        requiresApproval: false,
        reason: 'Uprawnienie przyznane przez rolę'
      };
    }
    
    // Domyślne uprawnienia dla managerów i providerów
    const defaultPermissions = {
      'team.viewMembers': userRole.isManager,
      'team.addMembers': userRole.isManager,
      'team.removeMembers': userRole.isManager,
      'team.changeMemberRoles': userRole.isManager,
      'orders.viewAll': userRole.isManager,
      'orders.viewAssigned': true,
      'orders.create': true,
      'orders.assign': userRole.isManager,
      'orders.reassign': userRole.isManager,
      'orders.cancel': userRole.isManager,
      'orders.complete': true,
      'finances.viewWallet': userRole.isManager,
      'finances.deposit': userRole.isManager,
      'finances.withdraw': userRole.isManager,
      'finances.viewInvoices': userRole.isManager,
      'finances.generateInvoices': userRole.isManager,
      'finances.payInvoices': userRole.isManager,
      'resourcePool.view': userRole.isManager,
      'resourcePool.manageLimits': userRole.isManager,
      'workflow.view': userRole.isManager,
      'workflow.configure': userRole.isManager,
      'settings.view': userRole.isManager,
      'settings.edit': userRole.isManager
    };
    
    const hasPermission = defaultPermissions[action] || false;
    
    return {
      allowed: hasPermission,
      requiresApproval: false,
      reason: hasPermission ? 'Uprawnienie domyślne' : 'Brak uprawnień'
    };
  } catch (error) {
    console.error('Error checking permission:', error);
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Błąd sprawdzania uprawnień'
    };
  }
}

/**
 * Loguje akcję użytkownika w audit log
 * @param {String} companyId - ID firmy
 * @param {String} userId - ID użytkownika
 * @param {String} action - Typ akcji
 * @param {Object} details - Szczegóły akcji
 * @param {Object} options - Opcje (ipAddress, userAgent, requiresApproval, etc.)
 */
async function logAction(companyId, userId, action, details = {}, options = {}) {
  try {
    await CompanyAuditLog.logAction(companyId, userId, action, details, options);
  } catch (error) {
    console.error('Error logging action:', error);
  }
}

/**
 * Middleware do sprawdzania uprawnień
 * @param {String} action - Akcja do sprawdzenia
 * @param {Function} getContext - Funkcja do pobrania kontekstu z req
 */
function requirePermission(action, getContext = null) {
  return async (req, res, next) => {
    try {
      const companyId = req.companyId || req.params.companyId || req.body.companyId;
      
      if (!companyId) {
        return res.status(400).json({ message: 'ID firmy jest wymagane' });
      }
      
      const context = getContext ? getContext(req) : {};
      const permission = await checkPermission(req.user._id, companyId, action, context);
      
      if (!permission.allowed) {
        // Loguj próbę nieautoryzowanego dostępu
        await logAction(companyId, req.user._id, action, {}, {
          status: 'failed',
          description: `Nieautoryzowana próba dostępu: ${permission.reason}`,
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        });
        
        return res.status(403).json({
          message: 'Brak uprawnień',
          reason: permission.reason
        });
      }
      
      // Jeśli wymaga zatwierdzenia, zapisz w req
      if (permission.requiresApproval) {
        req.requiresApproval = true;
      }
      
      req.permission = permission;
      next();
    } catch (error) {
      console.error('Permission middleware error:', error);
      res.status(500).json({ message: 'Błąd sprawdzania uprawnień' });
    }
  };
}

module.exports = {
  getUserCompanyRole,
  checkPermission,
  logAction,
  requirePermission
};

