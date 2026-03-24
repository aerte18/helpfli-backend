const mongoose = require('mongoose');

const CompanyAuditLogSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  
  // Użytkownik który wykonał akcję
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Rola użytkownika w momencie akcji
  userRole: { type: String }, // 'owner', 'manager', 'provider', lub ID CompanyRole
  userRoleName: { type: String }, // Nazwa roli dla łatwiejszego wyszukiwania
  
  // Typ akcji
  action: {
    type: {
      type: String,
      enum: [
        'team.add', 'team.remove', 'team.role_change', 'team.invite',
        'order.create', 'order.assign', 'order.reassign', 'order.cancel', 'order.complete',
        'finance.deposit', 'finance.withdraw', 'finance.invoice_generate', 'finance.invoice_pay',
        'resourcePool.limit_change', 'resourcePool.strategy_change',
        'workflow.configure', 'workflow.template_add', 'workflow.escalation_add',
        'settings.update', 'role.create', 'role.update', 'role.delete', 'permission.change',
        'subscription.change', 'company.delete'
      ],
      required: true
    },
    category: { type: String }, // 'team', 'order', 'finance', etc.
    description: { type: String } // Opis akcji
  },
  
  // Szczegóły akcji
  details: {
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Użytkownik na którym wykonano akcję
    targetOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    targetInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyInvoice' },
    oldValue: { type: mongoose.Schema.Types.Mixed }, // Poprzednia wartość (dla zmian)
    newValue: { type: mongoose.Schema.Types.Mixed }, // Nowa wartość
    amount: { type: Number }, // Kwota (dla akcji finansowych)
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} } // Dodatkowe dane
  },
  
  // Status akcji
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed', 'failed'],
    default: 'completed'
  },
  
  // Zatwierdzenie (jeśli wymagane)
  approval: {
    required: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    rejectionReason: { type: String }
  },
  
  // IP i User-Agent
  ipAddress: { type: String },
  userAgent: { type: String },
  
  // Timestamp
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: false // Używamy tylko createdAt
});

// Indeksy dla szybkiego wyszukiwania
CompanyAuditLogSchema.index({ company: 1, createdAt: -1 });
CompanyAuditLogSchema.index({ user: 1, createdAt: -1 });
CompanyAuditLogSchema.index({ 'action.type': 1, createdAt: -1 });
CompanyAuditLogSchema.index({ status: 1 });
CompanyAuditLogSchema.index({ 'approval.required': 1, status: 1 });

// Metody statyczne
CompanyAuditLogSchema.statics.logAction = async function(companyId, userId, action, details = {}, options = {}) {
  try {
    const User = require('../models/User');
    const CompanyRole = require('./CompanyRole');
    const Company = require('../models/Company');
    
    const user = await User.findById(userId);
    const company = await Company.findById(companyId);
    
    if (!user || !company) {
      throw new Error('User or company not found');
    }
    
    // Pobierz rolę użytkownika
    let userRole = user.roleInCompany || 'provider';
    let userRoleName = userRole;
    
    // Jeśli użytkownik ma custom role, pobierz szczegóły
    if (user.companyRoleId) {
      const customRole = await CompanyRole.findById(user.companyRoleId);
      if (customRole) {
        userRole = customRole._id.toString();
        userRoleName = customRole.name;
      }
    }
    
    // Określ kategorię akcji
    const category = action.split('.')[0];
    
    const logEntry = await this.create({
      company: companyId,
      user: userId,
      userRole: userRole,
      userRoleName: userRoleName,
      action: {
        type: action,
        category: category,
        description: options.description || action
      },
      details: {
        ...details,
        metadata: options.metadata || {}
      },
      status: options.status || 'completed',
      approval: {
        required: options.requiresApproval || false
      },
      ipAddress: options.ipAddress,
      userAgent: options.userAgent
    });
    
    return logEntry;
  } catch (error) {
    console.error('Error logging action:', error);
    return null;
  }
};

module.exports = mongoose.model('CompanyAuditLog', CompanyAuditLogSchema);







