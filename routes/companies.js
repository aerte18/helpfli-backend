?const express = require('express');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const CompanyRole = require('../models/CompanyRole');
const CompanyJoinRequest = require('../models/CompanyJoinRequest');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const router = express.Router();

// Debug middleware - loguj wszystkie requesty
router.use((req, res, next) => {
  if (req.path && (req.path.includes('/invoices') || req.path.includes('/resource-pool') || req.path.includes('/wallet') || req.path.includes('/workflow') || req.path.includes('/audit-log'))) {
    console.log('[COMPANIES_ROUTER_DEBUG] Request:', req.method, req.path, 'Full URL:', req.originalUrl);
  }
  next();
});

// Middleware sprawdzające uprawnienia do zarządzania firmą
const requireCompanyAccess = async (req, res, next) => {
  try {
    const companyId = req.params.companyId || req.body.companyId;
    const user = await User.findById(req.user._id).populate('company');
    
    if (!companyId) {
      return res.status(400).json({ message: 'ID firmy jest wymagane' });
    }

    // Sprawdź czy użytkownik ma dostęp do firmy
    if (user.company && user.company._id.toString() === companyId) {
      if (user.canManageCompany()) {
        req.companyAccess = { canManage: true, canView: true };
        req.companyId = companyId;
        return next();
      } else {
        req.companyAccess = { canManage: false, canView: true };
        req.companyId = companyId;
        return next();
      }
    }

    // Sprawdź czy użytkownik jest adminem
    if (user.role === 'admin') {
      req.companyAccess = { canManage: true, canView: true };
      req.companyId = companyId;
      return next();
    }

    return res.status(403).json({ message: 'Brak uprawnień do tej firmy' });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// GET /api/companies - Lista firm użytkownika
router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    let companies = [];

    if (user.role === 'admin') {
      // Admin widzi wszystkie firmy
      companies = await Company.find({ isActive: true })
        .populate('owner', 'name email')
        .populate('providers', 'name email roleInCompany')
        .populate('managers', 'name email');
    } else {
      // Zwykły użytkownik widzi tylko swoje firmy
      companies = await Company.find({
        $or: [
          { owner: user._id },
          { managers: user._id },
          { providers: user._id }
        ],
        isActive: true
      })
      .populate('owner', 'name email')
      .populate('providers', 'name email roleInCompany')
      .populate('managers', 'name email');
    }

    res.json({
      success: true,
      companies: companies.map(company => ({
        _id: company._id,
        name: company.name,
        nip: company.nip,
        email: company.email,
        phone: company.phone,
        status: company.status,
        verified: company.verified,
        owner: company.owner,
        teamSize: company.teamSize,
        stats: company.stats,
        userRole: user.company?.toString() === company._id.toString() ? user.roleInCompany : null
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// GET /api/companies/:companyId - Szczegóły firmy
// WAŻNE: Wszystkie specyficzne routy muszą być PRZED /:companyId, żeby Express je dopasował pierwsze
// Express sprawdza routy w kolejności definicji i pierwszy pasujący route jest używany

// GET /api/companies/:companyId/invoices - Lista faktur
console.log('[COMPANIES_ROUTER] Registering route: GET /:companyId/invoices');
router.get('/:companyId/invoices', auth, requireCompanyAccess, async (req, res) => {
  console.log('[ROUTE] GET /:companyId/invoices matched!', req.params.companyId);
  try {
    const CompanyInvoice = require('../models/CompanyInvoice');
    const companyIdToUse = req.companyId || req.params.companyId;
    
    if (!companyIdToUse) {
      return res.status(400).json({ 
        success: false,
        message: 'Brak ID firmy' 
      });
    }

    const invoices = await CompanyInvoice.find({ company: companyIdToUse })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      invoices: invoices.map(inv => ({
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        type: inv.type,
        period: inv.period,
        summary: {
          ...inv.summary,
          totalFormatted: `${(inv.summary.total / 100).toFixed(2)} PLN`
        },
        status: inv.status,
        items: inv.items,
        issuedAt: inv.issuedAt,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        createdAt: inv.createdAt
      }))
    });
  } catch (error) {
    console.error('COMPANY_INVOICES_ERROR:', error);
    res.status(500).json({ 
      success: false,
      message: 'Błąd pobierania faktur', 
      error: error.message 
    });
  }
});

// GET /api/companies/:companyId/invoices/:invoiceId/pdf - Pobierz PDF faktury firmowej
router.get('/:companyId/invoices/:invoiceId/pdf', auth, requireCompanyAccess, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const CompanyInvoice = require('../models/CompanyInvoice');
    const invoice = await CompanyInvoice.findOne({
      _id: req.params.invoiceId,
      company: req.companyId || req.params.companyId
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Faktura nie znaleziona' });
    }

    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${invoice.invoiceNumber || 'faktura'}.pdf`
    );

    doc.pipe(res);

    // Nagłówek
    doc
      .fontSize(20)
      .text('Faktura VAT', { align: 'right' })
      .moveDown(0.5);

    doc
      .fontSize(10)
      .text(`Numer: ${invoice.invoiceNumber}`, { align: 'right' })
      .text(
        `Data wystawienia: ${invoice.issuedAt?.toLocaleDateString('pl-PL') || ''}`,
        { align: 'right' }
      )
      .text(
        `Okres: ${invoice.period?.startDate?.toLocaleDateString('pl-PL') || ''} - ${invoice.period?.endDate?.toLocaleDateString('pl-PL') || ''}`,
        { align: 'right' }
      )
      .text(
        `Termin płatności: ${invoice.dueDate?.toLocaleDateString('pl-PL') || ''}`,
        { align: 'right' }
      )
      .moveDown(1.5);

    // Sprzedawca / Nabywca
    doc
      .fontSize(11)
      .text('Sprzedawca:', { continued: false })
      .fontSize(10)
      .text(process.env.INVOICE_SELLER_NAME || 'Helpfli Sp. z o.o.')
      .text(process.env.INVOICE_SELLER_STREET || '')
      .text(
        `${process.env.INVOICE_SELLER_POSTAL || ''} ${
          process.env.INVOICE_SELLER_CITY || ''
        }`
      )
      .text(`NIP: ${process.env.INVOICE_SELLER_NIP || '-'}`)
      .moveDown(1);

    doc
      .fontSize(11)
      .text('Nabywca:', { continued: false })
      .fontSize(10)
      .text(invoice.companyData?.name || '')
      .text(invoice.companyData?.address?.street || '')
      .text(
        `${invoice.companyData?.address?.postalCode || ''} ${
          invoice.companyData?.address?.city || ''
        }`
      )
      .text(
        invoice.companyData?.nip ? `NIP: ${invoice.companyData.nip}` : 'NIP: -'
      )
      .moveDown(1.5);

    // Tabela pozycji
    doc.fontSize(11).text('Pozycje faktury:', { underline: true }).moveDown(0.5);

    doc.fontSize(10);

    invoice.items.forEach((item, idx) => {
      const qty = item.quantity || 1;
      const unit = (item.unitPrice || 0) / 100;
      const total = (item.totalPrice || 0) / 100;
      doc
        .text(
          `${idx + 1}. ${item.description} – ilość: ${qty}, cena jedn.: ${unit.toFixed(
            2
          )} ${invoice.summary.currency || 'PLN'}, wartość: ${total.toFixed(
            2
          )} ${invoice.summary.currency || 'PLN'}`,
          {
            align: 'left'
          }
        )
        .moveDown(0.25);
    });

    doc.moveDown(1);

    // Podsumowanie
    const currency = invoice.summary.currency || 'PLN';
    doc
      .fontSize(11)
      .text('Podsumowanie:', { underline: true })
      .moveDown(0.5)
      .fontSize(10)
      .text(
        `Wartość netto: ${(invoice.summary.subtotal / 100).toFixed(
          2
        )} ${currency}`
      )
      .text(
        `VAT ${invoice.summary.taxRate || 23}%: ${(invoice.summary.taxAmount / 100).toFixed(
          2
        )} ${currency}`
      )
      .text(
        `Do zapłaty brutto: ${(invoice.summary.total / 100).toFixed(
          2
        )} ${currency}`
      )
      .moveDown(2);

    doc
      .fontSize(9)
      .fillColor('#666666')
      .text(
        'Dokument wygenerowany automatycznie przez system Helpfli.',
        { align: 'center' }
      );

    doc.end();
  } catch (error) {
    console.error('COMPANY_INVOICE_PDF_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktury PDF', error: error.message });
  }
});

// GET /api/companies/:companyId/resource-pool - Resource Pool
console.log('[COMPANIES_ROUTER] Registering route: GET /:companyId/resource-pool');
router.get('/:companyId/resource-pool', auth, requireCompanyAccess, async (req, res) => {
  console.log('[ROUTE] GET /:companyId/resource-pool matched!', req.params.companyId);
  try {
    const { getCompanyResourcePoolStats } = require('../utils/resourcePool');
    const stats = await getCompanyResourcePoolStats(req.companyId);
    
    if (!stats) {
      const now = new Date();
      const defaultResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
      return res.json({
        success: true,
        stats: {
          aiQueries: { used: 0, limit: 0, remaining: 0, resetDate: defaultResetDate },
          fastTrack: { used: 0, limit: 0, remaining: 0, resetDate: defaultResetDate },
          providerResponses: { used: 0, limit: 0, remaining: 0, resetDate: defaultResetDate },
          allocationStrategy: 'equal',
          priorityMembers: []
        }
      });
    }
    
    res.json({
      success: true,
      stats: {
        aiQueries: {
          used: stats.aiQueries.used,
          limit: stats.aiQueries.limit,
          remaining: stats.aiQueries.remaining,
          resetDate: stats.aiQueries.resetDate
        },
        fastTrack: {
          used: stats.fastTrack.used,
          limit: stats.fastTrack.limit,
          remaining: stats.fastTrack.remaining,
          resetDate: stats.fastTrack.resetDate
        },
        providerResponses: {
          used: stats.providerResponses.used,
          limit: stats.providerResponses.limit,
          remaining: stats.providerResponses.remaining,
          resetDate: stats.providerResponses.resetDate
        },
        allocationStrategy: stats.allocationStrategy || 'equal',
        priorityMembers: stats.priorityMembers || []
      }
    });
  } catch (error) {
    console.error('RESOURCE_POOL_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania resource pool', error: error.message });
  }
});

// PUT /api/companies/:companyId/resource-pool/limits
router.put('/:companyId/resource-pool/limits', auth, requireCompanyAccess, async (req, res) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) {
      return res.status(404).json({ success: false, message: 'Firma nie znaleziona' });
    }
    
    const { aiQueries, fastTrack, responses } = req.body;
    
    if (!company.resourcePool) {
      company.resourcePool = {};
    }
    
    if (aiQueries !== undefined) {
      company.resourcePool.aiQueriesLimit = aiQueries;
      company.resourcePool.aiQueriesUsed = company.resourcePool.aiQueriesUsed || 0;
    }
    if (fastTrack !== undefined) {
      company.resourcePool.fastTrackLimit = fastTrack;
      company.resourcePool.fastTrackUsed = company.resourcePool.fastTrackUsed || 0;
    }
    if (responses !== undefined) {
      company.resourcePool.providerResponsesLimit = responses;
      company.resourcePool.providerResponsesUsed = company.resourcePool.providerResponsesUsed || 0;
    }
    
    await company.save();
    res.json({ success: true, message: 'Limity zaktualizowane' });
  } catch (error) {
    console.error('RESOURCE_POOL_LIMITS_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd aktualizacji limitów', error: error.message });
  }
});

// PUT /api/companies/:companyId/resource-pool/allocation-strategy
router.put('/:companyId/resource-pool/allocation-strategy', auth, requireCompanyAccess, async (req, res) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) {
      return res.status(404).json({ success: false, message: 'Firma nie znaleziona' });
    }
    
    const { strategy, priorityMembers } = req.body;
    
    if (!company.resourcePool) {
      company.resourcePool = {};
    }
    
    if (strategy) company.resourcePool.allocationStrategy = strategy;
    if (priorityMembers) company.resourcePool.priorityMembers = priorityMembers;
    
    await company.save();
    res.json({ success: true, message: 'Strategia zaktualizowana' });
  } catch (error) {
    console.error('RESOURCE_POOL_STRATEGY_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd aktualizacji strategii', error: error.message });
  }
});

// GET /api/companies/:companyId/wallet - Portfel firmy
console.log('[COMPANIES_ROUTER] Registering route: GET /:companyId/wallet');
router.get('/:companyId/wallet', auth, requireCompanyAccess, async (req, res) => {
  console.log('[ROUTE] GET /:companyId/wallet matched!', req.params.companyId);
  try {
    const CompanyWallet = require('../models/CompanyWallet');
    let wallet = await CompanyWallet.findOne({ company: req.companyId });
    
    if (!wallet) {
      wallet = await CompanyWallet.create({ company: req.companyId, balance: 0 });
    }
    
    res.json({
      success: true,
      wallet: {
        balance: wallet.balance,
        currency: wallet.currency || 'PLN',
        stats: {
          totalDeposited: wallet.stats?.totalDeposited || 0,
          totalWithdrawn: wallet.stats?.totalWithdrawn || 0,
          totalSpent: wallet.stats?.totalSpent || 0,
          totalEarned: wallet.stats?.totalEarned || 0,
          lastTransactionAt: wallet.stats?.lastTransactionAt || null
        }
      }
    });
  } catch (error) {
    console.error('WALLET_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania portfela', error: error.message });
  }
});

// GET /api/companies/:companyId/wallet/transactions
router.get('/:companyId/wallet/transactions', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWallet = require('../models/CompanyWallet');
    const wallet = await CompanyWallet.findOne({ company: req.companyId });
    
    if (!wallet) {
      return res.json({ success: true, transactions: [] });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    const transactions = (wallet.transactions || []).slice(0, limit);
    
    res.json({
      success: true,
      transactions: transactions.map(t => ({
        _id: t._id,
        type: t.type,
        amount: t.amount,
        description: t.description,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    console.error('WALLET_TRANSACTIONS_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania transakcji', error: error.message });
  }
});

// POST /api/companies/:companyId/wallet/deposit
router.post('/:companyId/wallet/deposit', auth, requireCompanyAccess, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const CompanyWallet = require('../models/CompanyWallet');
    
    let wallet = await CompanyWallet.findOne({ company: req.companyId });
    if (!wallet) {
      wallet = await CompanyWallet.create({ company: req.companyId, balance: 0, transactions: [] });
    }
    
    wallet.balance += amount;
    wallet.transactions.push({
      type: 'deposit',
      amount,
      description: description || 'Wpłata',
      createdAt: new Date()
    });
    
    await wallet.save();
    res.json({ success: true, message: 'Wpłata zrealizowana', balance: wallet.balance });
  } catch (error) {
    console.error('WALLET_DEPOSIT_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd wpłaty', error: error.message });
  }
});

// POST /api/companies/:companyId/wallet/withdraw
router.post('/:companyId/wallet/withdraw', auth, requireCompanyAccess, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const CompanyWallet = require('../models/CompanyWallet');
    
    let wallet = await CompanyWallet.findOne({ company: req.companyId });
    if (!wallet) {
      return res.status(400).json({ success: false, message: 'Portfel nie istnieje' });
    }
    
    if (wallet.balance < amount) {
      return res.status(400).json({ success: false, message: 'Niewystarczające środki' });
    }
    
    wallet.balance -= amount;
    wallet.transactions.push({
      type: 'withdrawal',
      amount: -amount,
      description: description || 'Wypłata',
      createdAt: new Date()
    });
    
    await wallet.save();
    res.json({ success: true, message: 'Wypłata zrealizowana', balance: wallet.balance });
  } catch (error) {
    console.error('WALLET_WITHDRAW_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd wypłaty', error: error.message });
  }
});

// GET /api/companies/:companyId/workflow - Workflow
console.log('[COMPANIES_ROUTER] Registering route: GET /:companyId/workflow');
router.get('/:companyId/workflow', auth, requireCompanyAccess, async (req, res) => {
  console.log('[ROUTE] GET /:companyId/workflow matched!', req.params.companyId);
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    let workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    
    if (!workflow) {
      workflow = await CompanyWorkflow.create({ company: req.companyId });
    }
    
    res.json({ success: true, workflow });
  } catch (error) {
    console.error('WORKFLOW_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania workflow', error: error.message });
  }
});

// PUT /api/companies/:companyId/workflow
router.put('/:companyId/workflow', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    let workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    
    if (!workflow) {
      workflow = await CompanyWorkflow.create({ company: req.companyId, ...req.body });
    } else {
      Object.assign(workflow, req.body);
      await workflow.save();
    }
    
    res.json({ success: true, workflow });
  } catch (error) {
    console.error('WORKFLOW_UPDATE_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd aktualizacji workflow', error: error.message });
  }
});

// GET /api/companies/:companyId/workflow/templates
router.get('/:companyId/workflow/templates', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    const workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    res.json({ success: true, templates: workflow?.templates || [] });
  } catch (error) {
    console.error('WORKFLOW_TEMPLATES_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania szablonów', error: error.message });
  }
});

// POST /api/companies/:companyId/workflow/templates
router.post('/:companyId/workflow/templates', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    let workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    if (!workflow) {
      workflow = await CompanyWorkflow.create({ company: req.companyId });
    }
    
    workflow.templates.push(req.body);
    await workflow.save();
    res.json({ success: true, template: workflow.templates[workflow.templates.length - 1] });
  } catch (error) {
    console.error('WORKFLOW_TEMPLATE_CREATE_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd tworzenia szablonu', error: error.message });
  }
});

// DELETE /api/companies/:companyId/workflow/templates/:templateId
router.delete('/:companyId/workflow/templates/:templateId', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    const workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    if (!workflow) {
      return res.status(404).json({ success: false, message: 'Workflow nie znaleziony' });
    }
    
    workflow.templates = workflow.templates.filter(t => t._id.toString() !== req.params.templateId);
    await workflow.save();
    res.json({ success: true });
  } catch (error) {
    console.error('WORKFLOW_TEMPLATE_DELETE_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd usuwania szablonu', error: error.message });
  }
});

// GET /api/companies/:companyId/workflow/escalations
router.get('/:companyId/workflow/escalations', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    const workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    res.json({ success: true, escalations: workflow?.escalations || [] });
  } catch (error) {
    console.error('WORKFLOW_ESCALATIONS_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania eskalacji', error: error.message });
  }
});

// POST /api/companies/:companyId/workflow/escalations
router.post('/:companyId/workflow/escalations', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    let workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    if (!workflow) {
      workflow = await CompanyWorkflow.create({ company: req.companyId });
    }
    
    workflow.escalations.push(req.body);
    await workflow.save();
    res.json({ success: true, escalation: workflow.escalations[workflow.escalations.length - 1] });
  } catch (error) {
    console.error('WORKFLOW_ESCALATION_CREATE_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd tworzenia eskalacji', error: error.message });
  }
});

// DELETE /api/companies/:companyId/workflow/escalations/:escalationId
router.delete('/:companyId/workflow/escalations/:escalationId', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyWorkflow = require('../models/CompanyWorkflow');
    const workflow = await CompanyWorkflow.findOne({ company: req.companyId });
    if (!workflow) {
      return res.status(404).json({ success: false, message: 'Workflow nie znaleziony' });
    }
    
    workflow.escalations = workflow.escalations.filter(e => e._id.toString() !== req.params.escalationId);
    await workflow.save();
    res.json({ success: true });
  } catch (error) {
    console.error('WORKFLOW_ESCALATION_DELETE_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd usuwania eskalacji', error: error.message });
  }
});

// GET /api/companies/:companyId/audit-log - Audit Log
console.log('[COMPANIES_ROUTER] Registering route: GET /:companyId/audit-log');
router.get('/:companyId/audit-log', auth, requireCompanyAccess, async (req, res) => {
  console.log('[ROUTE] GET /:companyId/audit-log matched!', req.params.companyId);
  try {
    const CompanyAuditLog = require('../models/CompanyAuditLog');
    const { action, userId, startDate, endDate } = req.query;
    
    const query = { company: req.companyId };
    if (action) query.action = action;
    if (userId) query.userId = userId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const logs = await CompanyAuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('userId', 'name email')
      .lean();
    
    res.json({
      success: true,
      logs: logs.map(log => ({
        _id: log._id,
        action: log.action,
        userId: log.userId,
        details: log.details,
        createdAt: log.createdAt
      }))
    });
  } catch (error) {
    console.error('AUDIT_LOG_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania audit log', error: error.message });
  }
});

// GET /api/companies/:companyId/orders - Lista zleceń wykonawców firmy (podgląd: kto ma jakie zlecenia, na jakim etapie)
router.get('/:companyId/orders', auth, requireCompanyAccess, async (req, res) => {
  try {
    const companyId = req.companyId || req.params.companyId;
    const { status, providerId, page = 1, limit = 20 } = req.query;

    const company = await Company.findById(companyId)
      .populate('providers', 'name email')
      .populate('owner', 'name email');
    if (!company) {
      return res.status(404).json({ success: false, message: 'Firma nie znaleziona' });
    }

    const memberIds = [
      ...(company.owner ? [company.owner._id] : []),
      ...(company.providers || []).map(p => p._id)
    ];
    if (memberIds.length === 0) {
      return res.json({
        success: true,
        orders: [],
        pagination: { page: 1, limit: Number(limit) || 20, total: 0, pages: 0 },
        providers: []
      });
    }

    const filter = { provider: { $in: memberIds } };
    if (status && status !== 'all') {
      if (status === 'open') filter.status = { $in: ['open', 'collecting_offers'] };
      else filter.status = status;
    }
    if (providerId) filter.provider = providerId;

    const Order = require('../models/Order');
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('provider', 'name email')
        .populate('client', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter)
    ]);

    res.json({
      success: true,
      orders: orders.map(o => ({
        _id: o._id,
        service: o.service,
        description: o.description,
        status: o.status,
        provider: o.provider,
        client: o.client,
        pricing: o.pricing,
        amountTotal: o.amountTotal,
        createdAt: o.createdAt,
        completedAt: o.completedAt,
        paymentPreference: o.paymentPreference,
        paidInSystem: o.paidInSystem
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      },
      providers: company.providers?.map(p => ({ _id: p._id, name: p.name, email: p.email })) || []
    });
  } catch (error) {
    console.error('COMPANY_ORDERS_ERROR:', error);
    res.status(500).json({ success: false, message: 'Błąd pobierania zleceń firmy', error: error.message });
  }
});

// GET /api/companies/:companyId/subscription - Pobierz subskrypcję biznesową dla firmy
router.get('/:companyId/subscription', auth, requireCompanyAccess, async (req, res) => {
  try {
    const UserSubscription = require('../models/UserSubscription');
    
    // Znajdź subskrypcję biznesową dla tej firmy
    // Subskrypcja biznesowa jest przypisana do właściciela firmy z flagą isBusinessPlan
    const company = await Company.findById(req.companyId).populate('owner');
    
    if (!company || !company.owner) {
      return res.status(404).json({ 
        success: false, 
        message: 'Firma lub właściciel nie został znaleziony' 
      });
    }

    // Szukaj subskrypcji biznesowej właściciela dla tej firmy
    const subscription = await UserSubscription.findOne({
      user: company.owner._id,
      companyId: req.companyId,
      isBusinessPlan: true,
      validUntil: { $gt: new Date() } // Tylko aktywne subskrypcje
    }).populate('user', 'name email');

    if (!subscription) {
      return res.json({
        success: true,
        subscription: null,
        message: 'Brak aktywnej subskrypcji biznesowej dla tej firmy'
      });
    }

    res.json({
      success: true,
      subscription: {
        _id: subscription._id,
        planKey: subscription.planKey,
        startedAt: subscription.startedAt,
        validUntil: subscription.validUntil,
        renews: subscription.renews,
        isTrial: subscription.isTrial,
        trialEndsAt: subscription.trialEndsAt,
        earlyAdopter: subscription.earlyAdopter,
        earlyAdopterDiscount: subscription.earlyAdopterDiscount,
        loyaltyMonths: subscription.loyaltyMonths,
        loyaltyDiscount: subscription.loyaltyDiscount,
        useCompanyResourcePool: subscription.useCompanyResourcePool,
        individualLimits: subscription.individualLimits,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        stripeCustomerId: subscription.stripeCustomerId
      }
    });
  } catch (error) {
    console.error('COMPANY_SUBSCRIPTION_ERROR:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Błąd pobierania subskrypcji firmy', 
      error: error.message 
    });
  }
});

// POST /api/companies/:companyId/ai/chat - Asystent AI dla firmy (MVP)
router.post('/:companyId/ai/chat', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess?.canManage) {
      return res.status(403).json({ message: 'Tylko właściciel lub manager może korzystać z Asystenta AI firmy.' });
    }
    const companyId = req.companyId || req.params.companyId;
    const { message, conversationHistory = [] } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ message: 'Podaj treść wiadomości.' });
    }

    const company = await Company.findById(companyId)
      .populate('owner', 'name')
      .populate('providers', 'name')
      .populate('managers', 'name')
      .lean();
    if (!company) {
      return res.status(404).json({ message: 'Firma nie znaleziona.' });
    }

    const Order = require('../models/Order');
    const memberIds = [
      ...(company.owner ? [company.owner._id] : []),
      ...(company.providers || []).map(p => p._id),
      ...(company.managers || []).map(m => m._id)
    ].filter(Boolean);
    const [inProgressCount, completedCount] = await Promise.all([
      Order.countDocuments({ provider: { $in: memberIds }, status: 'in_progress' }),
      Order.countDocuments({ provider: { $in: memberIds }, status: { $in: ['completed', 'rated', 'released'] } })
    ]);

    const teamSize = (company.providers?.length || 0) + (company.managers?.length ? company.managers.length : 0) + (company.owner ? 1 : 0);
    const context = {
      companyName: company.name,
      teamSize,
      inProgressOrders: inProgressCount,
      completedOrders: completedCount,
      providerNames: (company.providers || []).map(p => p.name).filter(Boolean).slice(0, 10)
    };

    const providerNamesList = context.providerNames.length ? context.providerNames.join(', ') : 'brak danych';
    const systemPrompt = `Jesteś Asystentem AI dla firmy "${context.companyName}" w systemie Helpfli.

KONTEKST: ${context.teamSize} członków zespołu, ${context.inProgressOrders} zleceń w realizacji, ${context.completedOrders} zleceń zakończonych. Wykonawcy: ${providerNamesList}.

INTENCJE – odpowiadaj krótko i konkretnie po polsku:
- "podsumuj zespół" / "kto w zespole" → podsumowanie: ile osób, kto (imiona z kontekstu).
- "kto ma wolne" / "komu przypisać" → na podstawie liczby zleceń w realizacji podpowiedz: przy ${context.inProgressOrders} w realizacji możesz sugerować osobę z listy lub "Sprawdź w Panel zleceń firmy, kto ma mniej zleceń".
- "podsumowanie miesiąca" / "jak idzie" → krótkie podsumowanie: zlecenia w realizacji, zakończone.
- "gdzie faktury" / "ustawienia" → "Faktury i portfel: Panel firmy → Rozliczenia / Portfel firmowy. Ustawienia: Panel firmy → Ustawienia."

Zawsze kończ konkretem. Gdy sugerujesz akcję (np. przypisanie), na końcu dodaj: "Możesz to zrobić w Panel zleceń firmy (Zlecenia → wybierz zlecenie → Przypisz wykonawcy)." Nie wymyślaj danych – tylko z podanego kontekstu.`;

    const messages = [
      ...conversationHistory.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : (m.text || m.message || '')
      })),
      { role: 'user', content: message.trim() }
    ].filter(m => m.content);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({
        response: `Podsumowanie: ${context.companyName} – ${context.teamSize} członków, ${context.inProgressOrders} zleceń w realizacji, ${context.completedOrders} zakończonych. Skonfiguruj ANTHROPIC_API_KEY, aby włączyć pełny Asystent AI.`
      });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: process.env.CLAUDE_DEFAULT || 'claude-3-5-haiku-20241022',
      max_tokens: 800,
      temperature: 0.3,
      system: systemPrompt,
      messages: messages.slice(-10)
    });

    const text = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
    const lowerMessage = (message || '').toLowerCase();
    const suggestOrders = /przypisz|przypisanie|komu przypisać|zlecenia firmy|panel zleceń/.test(lowerMessage);
    const payload = { response: text || 'Nie udało się wygenerować odpowiedzi.' };
    if (suggestOrders && companyId) {
      payload.actionCard = {
        label: 'Zobacz zlecenia firmy',
        path: `/company/${companyId}`,
        type: 'link'
      };
    }
    res.json(payload);
  } catch (err) {
    console.error('Company AI chat error:', err);
    res.status(500).json({ message: 'Błąd Asystenta AI. Spróbuj ponownie.', response: null });
  }
});

// TEN ROUTE MUSI BYĆ NA KOŃCU - przechwytuje wszystkie inne /:companyId requesty
console.log('[COMPANIES_ROUTER] Registering route: GET /:companyId (fallback - must be last)');
router.get('/:companyId', auth, requireCompanyAccess, async (req, res) => {
  console.log('[ROUTE] GET /:companyId matched (fallback route)', req.params.companyId);
  try {
    const company = await Company.findById(req.companyId)
      .populate('owner', 'name email phone')
      .populate('providers', 'name email phone location roleInCompany level')
      .populate('managers', 'name email phone');

    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    res.json({
      success: true,
      company: {
        _id: company._id,
        name: company.name,
        nip: company.nip,
        regon: company.regon,
        krs: company.krs,
        email: company.email,
        phone: company.phone,
        website: company.website,
        address: company.address,
        description: company.description,
        logo: company.logo,
        banner: company.banner,
        status: company.status,
        verified: company.verified,
        verifiedAt: company.verifiedAt,
        owner: company.owner,
        managers: company.managers,
        providers: company.providers,
        stats: company.stats,
        settings: company.settings,
        subscription: company.subscription,
        createdAt: company.createdAt,
        canManage: req.companyAccess.canManage
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies - Utwórz nową firmę
router.post('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    // Sprawdź czy użytkownik może utworzyć firmę
    if (user.isInCompany()) {
      return res.status(400).json({ message: 'Już należysz do firmy' });
    }

    const {
      name,
      nip,
      regon,
      krs,
      email,
      phone,
      website,
      address,
      description
    } = req.body;

    // Sprawdź czy firma z tym NIP już istnieje
    const existingCompany = await Company.findOne({ nip });
    if (existingCompany) {
      return res.status(400).json({ message: 'Firma z tym NIP już istnieje' });
    }

    // Utwórz firmę
    const company = new Company({
      name,
      nip,
      regon,
      krs,
      email: email || user.email,
      phone: phone || user.phone,
      website,
      address,
      description,
      owner: user._id
    });

    await company.save();

    // Zaktualizuj użytkownika
    user.company = company._id;
    user.roleInCompany = 'owner';
    user.role = 'company_owner';
    await user.save();

    res.status(201).json({
      success: true,
      message: 'Firma została utworzona',
      company: {
        _id: company._id,
        name: company.name,
        nip: company.nip,
        status: company.status
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// PUT /api/companies/:companyId - Aktualizuj dane firmy
router.put('/:companyId', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do edycji firmy' });
    }

    const company = await Company.findById(req.companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    const {
      name,
      email,
      phone,
      website,
      address,
      description,
      settings
    } = req.body;

    // Aktualizuj dane firmy
    if (name) company.name = name;
    if (email) company.email = email;
    if (phone) company.phone = phone;
    if (website) company.website = website;
    if (address) company.address = address;
    if (description) company.description = description;
    if (settings) company.settings = { ...company.settings, ...settings };

    await company.save();

    res.json({
      success: true,
      message: 'Dane firmy zostały zaktualizowane',
      company
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/invite - Zaproś użytkownika do firmy
router.post('/:companyId/invite', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do zapraszania' });
    }

    const { email, role = 'provider' } = req.body;
    
    // Znajdź użytkownika do zaproszenia
    const userToInvite = await User.findOne({ email });
    if (!userToInvite) {
      return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
    }

    // Sprawdź czy użytkownik już należy do firmy
    if (userToInvite.isInCompany()) {
      return res.status(400).json({ message: 'Użytkownik już należy do firmy' });
    }

    // Sprawdź czy użytkownik ma już zaproszenie
    if (userToInvite.companyInvitation && userToInvite.companyInvitation.status === 'pending') {
      return res.status(400).json({ message: 'Użytkownik ma już aktywne zaproszenie' });
    }

    // Wyślij zaproszenie
    userToInvite.companyInvitation = {
      companyId: req.companyId,
      invitedBy: req.user._id,
      invitedAt: new Date(),
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 dni
    };

    await userToInvite.save();

    res.json({
      success: true,
      message: 'Zaproszenie zostało wysłane',
      invitation: {
        email: userToInvite.email,
        role,
        expiresAt: userToInvite.companyInvitation.expiresAt
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/accept-invitation - Zaakceptuj zaproszenie
router.post('/:companyId/accept-invitation', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const company = await Company.findById(req.companyId);

    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    if (!user.companyInvitation || user.companyInvitation.companyId.toString() !== req.companyId) {
      return res.status(400).json({ message: 'Brak aktywnego zaproszenia' });
    }

    if (user.companyInvitation.status !== 'pending') {
      return res.status(400).json({ message: 'Zaproszenie nie jest aktywne' });
    }

    if (user.companyInvitation.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Zaproszenie wygasło' });
    }

    // Zaakceptuj zaproszenie
    await user.acceptCompanyInvitation();

    // Dodaj użytkownika do firmy
    await company.addProvider(user._id);

    res.json({
      success: true,
      message: 'Zaproszenie zostało zaakceptowane',
      company: {
        _id: company._id,
        name: company.name
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/reject-invitation - Odrzuć zaproszenie
router.post('/:companyId/reject-invitation', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user.companyInvitation || user.companyInvitation.companyId.toString() !== req.companyId) {
      return res.status(400).json({ message: 'Brak aktywnego zaproszenia' });
    }

    await user.rejectCompanyInvitation();

    res.json({
      success: true,
      message: 'Zaproszenie zostało odrzucone'
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// DELETE /api/companies/:companyId/members/:userId - Usuń członka z firmy
router.delete('/:companyId/members/:userId', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do usuwania członków' });
    }

    const company = await Company.findById(req.companyId);
    const userToRemove = await User.findById(req.params.userId);

    if (!company || !userToRemove) {
      return res.status(404).json({ message: 'Firma lub użytkownik nie został znaleziony' });
    }

    // Nie można usunąć właściciela
    if (company.owner.toString() === req.params.userId) {
      return res.status(400).json({ message: 'Nie można usunąć właściciela firmy' });
    }

    // Usuń z firmy
    await company.removeProvider(req.params.userId);
    await company.removeManager(req.params.userId);

    // Zaktualizuj użytkownika
    await userToRemove.leaveCompany();

    res.json({
      success: true,
      message: 'Członek został usunięty z firmy'
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// PUT /api/companies/:companyId/members/:userId/role - Zmień rolę członka
router.put('/:companyId/members/:userId/role', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do zmiany ról' });
    }

    const { role } = req.body;
    const company = await Company.findById(req.companyId);
    const user = await User.findById(req.params.userId);

    if (!company || !user) {
      return res.status(404).json({ message: 'Firma lub użytkownik nie został znaleziony' });
    }

    if (!['provider', 'manager'].includes(role)) {
      return res.status(400).json({ message: 'Nieprawidłowa rola' });
    }

    // Zaktualizuj rolę użytkownika
    user.roleInCompany = role;
    await user.save();

    // Zaktualizuj listy w firmie
    if (role === 'manager') {
      await company.addManager(user._id);
      await company.removeProvider(user._id);
    } else {
      await company.addProvider(user._id);
      await company.removeManager(user._id);
    }

    res.json({
      success: true,
      message: 'Rola została zmieniona',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        roleInCompany: user.roleInCompany
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// DELETE /api/companies/:companyId - Usuń firmę (tylko właściciel)
router.delete('/:companyId', auth, requireCompanyAccess, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const company = await Company.findById(req.companyId);

    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    // Tylko właściciel może usunąć firmę
    if (!user.isCompanyOwner() || company.owner.toString() !== user._id.toString()) {
      return res.status(403).json({ message: 'Tylko właściciel może usunąć firmę' });
    }

    // Usuń wszystkich członków z firmy
    const allMembers = await User.findByCompany(req.companyId);
    for (const member of allMembers) {
      await member.leaveCompany();
    }

    // Usuń firmę
    company.isActive = false;
    await company.save();

    res.json({
      success: true,
      message: 'Firma została usunięta'
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// GET /api/companies/:companyId/roles - Pobierz role firmy
router.get('/:companyId/roles', auth, requireCompanyAccess, async (req, res) => {
  try {
    const roles = await CompanyRole.find({
      company: req.companyId,
      isActive: true
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      roles: roles
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// PUT /api/companies/:companyId/members/:userId/custom-role - Przypisz custom rolę użytkownikowi
router.put('/:companyId/members/:userId/custom-role', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do przypisywania ról' });
    }

    const { roleId } = req.body;
    const company = await Company.findById(req.companyId);
    const user = await User.findById(req.params.userId);

    if (!company || !user) {
      return res.status(404).json({ message: 'Firma lub użytkownik nie został znaleziony' });
    }

    // Sprawdź czy użytkownik należy do firmy
    const isMember = company.owner.toString() === user._id.toString() ||
                     company.managers.some(m => m.toString() === user._id.toString()) ||
                     company.providers.some(p => p.toString() === user._id.toString());

    if (!isMember) {
      return res.status(400).json({ message: 'Użytkownik nie należy do tej firmy' });
    }

    // Jeśli roleId jest null, usuń rolę
    if (!roleId) {
      user.companyRoleId = undefined;
      await user.save();
      return res.json({
        success: true,
        message: 'Rola została usunięta',
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          companyRoleId: null
        }
      });
    }

    // Sprawdź czy rola istnieje i należy do firmy
    const role = await CompanyRole.findOne({
      _id: roleId,
      company: req.companyId,
      isActive: true
    });

    if (!role) {
      return res.status(404).json({ message: 'Rola nie została znaleziona' });
    }

    // Przypisz rolę
    user.companyRoleId = roleId;
    await user.save();

    res.json({
      success: true,
      message: 'Rola została przypisana',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        companyRoleId: user.companyRoleId
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/complete-onboarding - Oznacz onboarding jako ukończony
router.post('/:companyId/complete-onboarding', auth, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    
    const company = await Company.findByIdAndUpdate(
      companyId,
      { 
        onboardingCompleted: true,
        onboardingCompletedAt: new Date()
      },
      { new: true }
    );

    if (!company) {
      return res.status(404).json({ message: 'Firma nie znaleziona' });
    }

    res.json({ 
      success: true, 
      company,
      message: 'Onboarding został ukończony' 
    });
  } catch (error) {
    console.error('COMPLETE_ONBOARDING_ERROR:', error);
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// GET /api/companies/search - Wyszukiwanie firm (dla dołączania)
router.get('/search', auth, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ message: 'Wyszukiwanie wymaga minimum 2 znaków' });
    }

    const searchQuery = {
      status: 'active',
      verified: true,
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { nip: q.replace(/\s/g, '') },
        { email: { $regex: q, $options: 'i' } }
      ]
    };

    const companies = await Company.find(searchQuery)
      .select('name nip email phone address status verified')
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      companies: companies.map(company => ({
        _id: company._id,
        name: company.name,
        nip: company.nip,
        email: company.email,
        phone: company.phone,
        address: company.address,
        verified: company.verified
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/join-request - Wyślij prośbę o dołączenie do firmy
router.post('/:companyId/join-request', auth, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { message } = req.body;
    const providerId = req.user._id;

    // Sprawdź czy firma istnieje
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    // Sprawdź czy firma jest aktywna i zweryfikowana
    if (company.status !== 'active' || !company.verified) {
      return res.status(400).json({ message: 'Firma nie przyjmuje nowych członków' });
    }

    // Sprawdź czy użytkownik jest providerem
    const provider = await User.findById(providerId);
    if (provider.role !== 'provider') {
      return res.status(400).json({ message: 'Tylko wykonawcy mogą dołączać do firm' });
    }

    // Sprawdź czy użytkownik już należy do firmy
    if (provider.isInCompany()) {
      return res.status(400).json({ message: 'Już należysz do firmy' });
    }

    // Sprawdź czy istnieje już aktywna prośba
    const hasActiveRequest = await CompanyJoinRequest.hasActiveRequest(companyId, providerId);
    if (hasActiveRequest) {
      return res.status(400).json({ message: 'Masz już aktywną prośbę o dołączenie do tej firmy' });
    }

    // Utwórz prośbę
    const joinRequest = new CompanyJoinRequest({
      company: companyId,
      provider: providerId,
      message: message || '',
      status: 'pending'
    });

    await joinRequest.save();

    // Powiadom właściciela firmy (opcjonalnie - można dodać powiadomienie)
    // TODO: Dodać powiadomienie do owner/managers

    res.json({
      success: true,
      message: 'Prośba o dołączenie została wysłana',
      request: {
        _id: joinRequest._id,
        company: {
          _id: company._id,
          name: company.name
        },
        status: joinRequest.status,
        createdAt: joinRequest.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// GET /api/companies/:companyId/join-requests - Lista próśb o dołączenie (dla owner/manager)
router.get('/:companyId/join-requests', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do przeglądania próśb' });
    }

    const { status } = req.query;
    const query = { company: req.companyId };
    if (status) {
      query.status = status;
    }

    const requests = await CompanyJoinRequest.find(query)
      .populate('provider', 'name email phone location level')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      requests: requests.map(req => ({
        _id: req._id,
        provider: {
          _id: req.provider._id,
          name: req.provider.name,
          email: req.provider.email,
          phone: req.provider.phone,
          location: req.provider.location,
          level: req.provider.level
        },
        message: req.message,
        status: req.status,
        createdAt: req.createdAt,
        reviewedAt: req.reviewedAt,
        rejectionReason: req.rejectionReason
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/join-requests/:requestId/approve - Zaakceptuj prośbę
router.post('/:companyId/join-requests/:requestId/approve', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do akceptowania próśb' });
    }

    const { requestId } = req.params;
    const joinRequest = await CompanyJoinRequest.findById(requestId)
      .populate('provider');

    if (!joinRequest) {
      return res.status(404).json({ message: 'Prośba nie została znaleziona' });
    }

    if (joinRequest.company.toString() !== req.companyId) {
      return res.status(403).json({ message: 'Prośba nie należy do tej firmy' });
    }

    if (joinRequest.status !== 'pending') {
      return res.status(400).json({ message: 'Prośba została już rozpatrzona' });
    }

    // Sprawdź czy provider nadal nie należy do firmy
    const provider = await User.findById(joinRequest.provider._id);
    if (provider.isInCompany()) {
      return res.status(400).json({ message: 'Użytkownik już należy do innej firmy' });
    }

    // Zaakceptuj prośbę
    joinRequest.status = 'approved';
    joinRequest.reviewedBy = req.user._id;
    joinRequest.reviewedAt = new Date();
    await joinRequest.save();

    // Dodaj providera do firmy
    const company = await Company.findById(req.companyId);
    await company.addProvider(provider._id);

    // Zaktualizuj użytkownika
    provider.company = company._id;
    provider.roleInCompany = 'provider';
    await provider.save();

    // TODO: Wysłać powiadomienie do providera

    res.json({
      success: true,
      message: 'Prośba została zaakceptowana',
      request: {
        _id: joinRequest._id,
        status: joinRequest.status
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/join-requests/:requestId/reject - Odrzuć prośbę
router.post('/:companyId/join-requests/:requestId/reject', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do odrzucania próśb' });
    }

    const { requestId } = req.params;
    const { reason } = req.body;
    const joinRequest = await CompanyJoinRequest.findById(requestId);

    if (!joinRequest) {
      return res.status(404).json({ message: 'Prośba nie została znaleziona' });
    }

    if (joinRequest.company.toString() !== req.companyId) {
      return res.status(403).json({ message: 'Prośba nie należy do tej firmy' });
    }

    if (joinRequest.status !== 'pending') {
      return res.status(400).json({ message: 'Prośba została już rozpatrzona' });
    }

    // Odrzuć prośbę
    joinRequest.status = 'rejected';
    joinRequest.reviewedBy = req.user._id;
    joinRequest.reviewedAt = new Date();
    joinRequest.rejectionReason = reason || '';
    await joinRequest.save();

    // TODO: Wysłać powiadomienie do providera

    res.json({
      success: true,
      message: 'Prośba została odrzucona',
      request: {
        _id: joinRequest._id,
        status: joinRequest.status
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
});

// POST /api/companies/:companyId/invoices/generate - Generuj fakturę (alias dla billing/generate-invoice)
router.post('/:companyId/invoices/generate', auth, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyInvoice = require('../models/CompanyInvoice');
    const { companyId } = req.params;
    const { startDate, endDate, dueDate, notes, preview } = req.body;

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    const dayjs = require('dayjs');
    const start = startDate ? dayjs(startDate).startOf('day').toDate() : dayjs().startOf('month').toDate();
    const end = endDate ? dayjs(endDate).endOf('day').toDate() : dayjs().endOf('month').toDate();
    const due = dueDate ? dayjs(dueDate).toDate() : null;

    // Użyj funkcji generateMonthlyInvoice z companyWallet
    const { generateMonthlyInvoice } = require('../utils/companyWallet');
    const result = await generateMonthlyInvoice(
      companyId,
      start,
      end,
      {
        type: startDate && endDate ? 'custom_period' : 'monthly_summary',
        notes: notes || '',
        dueDate: due
      }
    );

    // Jeśli to tylko podgląd i brak transakcji, zwróć informację zamiast błędu
    if (preview && !result.success) {
      return res.json({
        success: false,
        message: result.error || 'Brak transakcji do fakturowania w wybranym okresie',
        invoice: null
      });
    }

    if (!result.success) {
      return res.status(400).json({ 
        success: false,
        message: result.error || 'Nie udało się wygenerować faktury',
        error: result.error
      });
    }

    // Jeśli to tylko podgląd, zwróć dane i usuń fakturę draft
    if (preview) {
      const previewData = {
        success: true,
        invoice: {
          _id: result.invoice._id,
          invoiceNumber: result.invoice.invoiceNumber,
          period: {
            startDate: result.invoice.period.startDate,
            endDate: result.invoice.period.endDate
          },
          summary: {
            subtotal: result.invoice.summary.subtotal,
            taxRate: result.invoice.summary.taxRate,
            taxAmount: result.invoice.summary.taxAmount,
            total: result.invoice.summary.total,
            totalFormatted: `${(result.invoice.summary.total / 100).toFixed(2)} PLN`
          },
          status: result.invoice.status,
          itemsCount: result.invoice.items.length,
          dueDate: result.invoice.dueDate
        }
      };
      // Usuń fakturę draft (tylko podgląd)
      await CompanyInvoice.findByIdAndDelete(result.invoice._id);
      return res.json(previewData);
    }

    // Zmień status faktury na 'issued' (wystawiona)
    result.invoice.status = 'issued';
    result.invoice.issuedAt = new Date();
    await result.invoice.save();

    // Powiadom właściciela firmy
    try {
      const NotificationService = require('../services/NotificationService');
      await NotificationService.sendNotification(
        'company_invoice_generated',
        [company.owner],
        {
          companyName: company.name,
          invoiceNumber: result.invoice.invoiceNumber,
          period: `${dayjs(start).format('YYYY-MM-DD')} - ${dayjs(end).format('YYYY-MM-DD')}`,
          amount: (result.invoice.summary.total / 100).toFixed(2)
        }
      );
    } catch (notifyErr) {
      console.error('COMPANY_INVOICE_NOTIFICATION_ERROR:', notifyErr);
    }

    res.json({
      success: true,
      message: 'Faktura została wygenerowana',
      invoice: {
        _id: result.invoice._id,
        invoiceNumber: result.invoice.invoiceNumber,
        period: {
          startDate: result.invoice.period.startDate,
          endDate: result.invoice.period.endDate
        },
        summary: {
          subtotal: result.invoice.summary.subtotal,
          taxAmount: result.invoice.summary.taxAmount,
          total: result.invoice.summary.total,
          totalFormatted: `${(result.invoice.summary.total / 100).toFixed(2)} PLN`
        },
        status: result.invoice.status,
        itemsCount: result.invoice.items.length,
        issuedAt: result.invoice.issuedAt,
        dueDate: result.invoice.dueDate
      }
    });
  } catch (error) {
    console.error('COMPANY_GENERATE_INVOICE_ERROR:', error);
    res.status(500).json({ 
      success: false,
      message: 'Błąd generowania faktury', 
      error: error.message 
    });
  }
});

// POST /api/companies/:companyId/invoices/:invoiceId/pay - Opłać fakturę z portfela firmowego
router.post('/:companyId/invoices/:invoiceId/pay', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do opłacania faktur' });
    }

    const { invoiceId } = req.params;
    const CompanyInvoice = require('../models/CompanyInvoice');
    const invoice = await CompanyInvoice.findOne({
      _id: invoiceId,
      company: req.companyId
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Faktura nie została znaleziona' });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ message: 'Faktura została już opłacona' });
    }

    if (invoice.status === 'cancelled') {
      return res.status(400).json({ message: 'Nie można opłacić anulowanej faktury' });
    }

    // Opłać z portfela firmowego
    const { payFromWallet } = require('../utils/companyWallet');
    const paymentResult = await payFromWallet(
      req.companyId,
      invoice.summary.total,
      {
        type: 'invoice_payment',
        invoiceId: invoice._id,
        description: `Opłata faktury ${invoice.invoiceNumber}`
      }
    );

    if (!paymentResult.success) {
      return res.status(400).json({ 
        message: paymentResult.error || 'Nie udało się opłacić faktury z portfela',
        error: paymentResult.error
      });
    }

    // Oznacz fakturę jako opłaconą
    await invoice.markAsPaid(
      'company_wallet',
      paymentResult.transactionId,
      paymentResult.transactionId,
      invoice.summary.total
    );

    res.json({
      success: true,
      message: 'Faktura została opłacona',
      invoice: {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        paidAt: invoice.paidAt
      }
    });
  } catch (error) {
    console.error('COMPANY_PAY_INVOICE_ERROR:', error);
    res.status(500).json({ 
      success: false,
      message: 'Błąd opłacania faktury', 
      error: error.message 
    });
  }
});

console.log('[COMPANIES_ROUTER] Total routes registered:', router.stack.length);
router.stack.forEach((layer, idx) => {
  if (layer.route) {
    const path = layer.route.path;
    if (path.includes('invoices') || path.includes('resource-pool') || path.includes('wallet') || path.includes('workflow') || path.includes('audit-log')) {
      console.log(`[COMPANIES_ROUTER] Route ${idx}: ${Object.keys(layer.route.methods).join(',').toUpperCase()} ${path}`);
    }
  }
});
// Eksportuj router i middleware dla innych modułów
module.exports = router;
module.exports.requireCompanyAccess = requireCompanyAccess;











