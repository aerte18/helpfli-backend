const mongoose = require('mongoose');

const CompanyRoleSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  
  // Nazwa roli
  name: { type: String, required: true }, // np. "Senior Provider", "Team Lead", "Accountant"
  
  // Opis roli
  description: { type: String },
  
  // Czy rola jest domyślna (nie można jej usunąć)
  isDefault: { type: Boolean, default: false },
  
  // Czy rola jest aktywna
  isActive: { type: Boolean, default: true },
  
  // Uprawnienia szczegółowe (granularne)
  permissions: {
    // Zarządzanie zespołem
    team: {
      viewMembers: { type: Boolean, default: false },
      addMembers: { type: Boolean, default: false },
      removeMembers: { type: Boolean, default: false },
      changeMemberRoles: { type: Boolean, default: false },
      inviteMembers: { type: Boolean, default: false }
    },
    
    // Zlecenia
    orders: {
      viewAll: { type: Boolean, default: false },
      viewAssigned: { type: Boolean, default: true },
      create: { type: Boolean, default: false },
      assign: { type: Boolean, default: false },
      reassign: { type: Boolean, default: false },
      cancel: { type: Boolean, default: false },
      complete: { type: Boolean, default: true },
      approve: { type: Boolean, default: false }
    },
    
    // Finanse
    finances: {
      viewWallet: { type: Boolean, default: false },
      deposit: { type: Boolean, default: false },
      withdraw: { type: Boolean, default: false },
      viewInvoices: { type: Boolean, default: false },
      generateInvoices: { type: Boolean, default: false },
      payInvoices: { type: Boolean, default: false },
      viewTransactions: { type: Boolean, default: false }
    },
    
    // Resource Pool
    resourcePool: {
      view: { type: Boolean, default: false },
      manageLimits: { type: Boolean, default: false },
      changeStrategy: { type: Boolean, default: false },
      manualAllocation: { type: Boolean, default: false }
    },
    
    // Workflow
    workflow: {
      view: { type: Boolean, default: false },
      configure: { type: Boolean, default: false },
      manageTemplates: { type: Boolean, default: false },
      manageEscalations: { type: Boolean, default: false },
      assignOrders: { type: Boolean, default: false }
    },
    
    // Analityka i raporty
    analytics: {
      view: { type: Boolean, default: false },
      export: { type: Boolean, default: false },
      viewTeamPerformance: { type: Boolean, default: false },
      viewRevenueReports: { type: Boolean, default: false }
    },
    
    // Ustawienia firmy
    settings: {
      view: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      manageRoles: { type: Boolean, default: false },
      managePermissions: { type: Boolean, default: false },
      deleteCompany: { type: Boolean, default: false }
    },
    
    // Uprawnienia specjalne
    special: {
      bypassApproval: { type: Boolean, default: false }, // Pomijanie wymaganych zatwierdzeń
      viewAllData: { type: Boolean, default: false }, // Dostęp do wszystkich danych firmy
      impersonateMembers: { type: Boolean, default: false }, // Działanie w imieniu innych członków
      manageSubscriptions: { type: Boolean, default: false } // Zarządzanie subskrypcjami
    }
  },
  
  // Ograniczenia (jeśli rola ma ograniczenia)
  restrictions: {
    maxOrdersPerMonth: { type: Number, default: null }, // null = brak limitu
    maxWithdrawalAmount: { type: Number, default: null }, // W groszach, null = brak limitu
    allowedServices: [{ type: String }], // Puste = wszystkie usługi
    allowedLocations: [{ type: String }], // Puste = wszystkie lokalizacje
    workingHours: {
      start: { type: String }, // Format: "HH:mm", np. "09:00"
      end: { type: String }, // Format: "HH:mm", np. "17:00"
      timezone: { type: String, default: 'Europe/Warsaw' }
    }
  },
  
  // Czy wymaga zatwierdzenia dla niektórych akcji
  requiresApproval: {
    withdraw: { type: Boolean, default: false },
    reassignOrder: { type: Boolean, default: false },
    cancelOrder: { type: Boolean, default: false },
    removeMember: { type: Boolean, default: false }
  },
  
  // Kto może zatwierdzać akcje tej roli
  approvalBy: {
    type: String,
    enum: ['owner', 'manager', 'specific_role', 'any_manager'],
    default: 'manager'
  },
  approvalRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyRole' }, // Jeśli approvalBy === 'specific_role'
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indeksy
CompanyRoleSchema.index({ company: 1, name: 1 }, { unique: true });
CompanyRoleSchema.index({ company: 1, isActive: 1 });

// Pre-save middleware
CompanyRoleSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Metody instancji
CompanyRoleSchema.methods.hasPermission = function(category, permission) {
  if (!this.isActive) return false;
  
  const categoryPerms = this.permissions[category];
  if (!categoryPerms) return false;
  
  return categoryPerms[permission] === true;
};

CompanyRoleSchema.methods.canPerformAction = async function(action, context = {}) {
  // Sprawdź podstawowe uprawnienia
  const permissionMap = {
    'team.viewMembers': () => this.hasPermission('team', 'viewMembers'),
    'team.addMembers': () => this.hasPermission('team', 'addMembers'),
    'team.removeMembers': () => this.hasPermission('team', 'removeMembers'),
    'team.changeMemberRoles': () => this.hasPermission('team', 'changeMemberRoles'),
    'orders.viewAll': () => this.hasPermission('orders', 'viewAll'),
    'orders.create': () => this.hasPermission('orders', 'create'),
    'orders.assign': () => this.hasPermission('orders', 'assign'),
    'orders.reassign': () => this.hasPermission('orders', 'reassign'),
    'orders.cancel': () => this.hasPermission('orders', 'cancel'),
    'finances.viewWallet': () => this.hasPermission('finances', 'viewWallet'),
    'finances.deposit': () => this.hasPermission('finances', 'deposit'),
    'finances.withdraw': () => this.hasPermission('finances', 'withdraw'),
    'finances.generateInvoices': () => this.hasPermission('finances', 'generateInvoices'),
    'resourcePool.manageLimits': () => this.hasPermission('resourcePool', 'manageLimits'),
    'workflow.configure': () => this.hasPermission('workflow', 'configure'),
    'settings.edit': () => this.hasPermission('settings', 'edit')
  };
  
  const hasPermission = permissionMap[action] ? permissionMap[action]() : false;
  
  if (!hasPermission) return false;
  
    // Sprawdź ograniczenia
    if (action === 'orders.create' && this.restrictions.maxOrdersPerMonth !== null) {
      // Sprawdź liczbę zleceń w tym miesiącu
      const Order = require('./Order');
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      
      const ordersThisMonth = await Order.countDocuments({
        provider: context.userId,
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
      });
      
      if (ordersThisMonth >= this.restrictions.maxOrdersPerMonth) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: `Osiągnięto limit zleceń w tym miesiącu (${this.restrictions.maxOrdersPerMonth})`
        };
      }
    }
  
  if (action === 'finances.withdraw' && this.restrictions.maxWithdrawalAmount !== null) {
    const amount = context.amount || 0;
    if (amount > this.restrictions.maxWithdrawalAmount) {
      return false;
    }
  }
  
  // Sprawdź czy wymaga zatwierdzenia
  if (this.requiresApproval[action.split('.')[1]]) {
    return { allowed: true, requiresApproval: true };
  }
  
  return { allowed: true, requiresApproval: false };
};

module.exports = mongoose.model('CompanyRole', CompanyRoleSchema);

