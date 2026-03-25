// Centralne rozliczenia dla firm (Multi-tenant)
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const dayjs = require('dayjs');
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice'); // Jeśli istnieje, jeśli nie - utworzymy

const logger = require('../utils/logger');

// Middleware sprawdzające dostęp do firmy
const requireCompanyAccess = async (req, res, next) => {
  try {
    const { companyId } = req.params;

    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: 'Brak autoryzacji' });
    }

    const user = await User.findById(req.user._id);

    if (!companyId) {
      return res.status(400).json({ message: 'ID firmy jest wymagane' });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    const canAccess = user.role === 'admin' ||
                      company.isOwner(user._id) ||
                      company.isManager(user._id) ||
                      company.isProvider(user._id);

    if (canAccess) {
      req.company = company;
      req.companyId = company._id.toString();
      return next();
    }

    return res.status(403).json({ message: 'Brak uprawnień do zarządzania firmą' });
  } catch (error) {
    logger.error('[REQUIRE_COMPANY_ACCESS]', error);
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// GET /api/companies/:companyId/billing/summary - Podsumowanie rozliczeń
router.get('/:companyId/billing/summary', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const company = req.company;
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];

    // 1. Przychody firmy (wszystkie płatności od wykonawców firmy)
    const revenue = await Payment.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        status: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        byPurpose: {
          $push: {
            purpose: '$purpose',
            amount: '$amount'
          }
        }
      }}
    ]);

    // 2. Opłaty platformowe (platform fee)
    const platformFees = await Payment.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        status: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: null,
        totalFees: { $sum: '$platformFeeAmount' },
        totalRevenue: { $sum: '$amount' }
      }}
    ]);

    // 3. Rozliczenia per wykonawca
    const providerBilling = await Payment.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        status: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$provider',
        totalRevenue: { $sum: '$amount' },
        platformFees: { $sum: '$platformFeeAmount' },
        netRevenue: { $sum: { $subtract: ['$amount', '$platformFeeAmount'] } },
        paymentCount: { $sum: 1 }
      }},
      { $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'providerData'
      }},
      { $unwind: '$providerData' },
      { $project: {
        providerId: '$_id',
        providerName: '$providerData.name',
        totalRevenue: 1,
        platformFees: 1,
        netRevenue: 1,
        paymentCount: 1
      }},
      { $sort: { totalRevenue: -1 } }
    ]);

    // 4. Podsumowanie
    const revenueData = revenue[0] || { total: 0, count: 0 };
    const feesData = platformFees[0] || { totalFees: 0, totalRevenue: 0 };

    const payload = {
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      company: {
        _id: company._id,
        name: company.name
      },
      summary: {
        totalRevenue: revenueData.total,
        totalPayments: revenueData.count,
        platformFees: feesData.totalFees,
        netRevenue: revenueData.total - feesData.totalFees,
        feePercentage: revenueData.total > 0 ? (feesData.totalFees / revenueData.total) * 100 : 0
      },
      byProvider: providerBilling
    };

    // Jeśli format=csv – zwróć CSV
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=helpfli_rozliczenia_firmy_${company.name || 'firma'}.csv`
      );

      const header = [
        'Wykonawca',
        'Przychód brutto (PLN)',
        'Prowizja Helpfli (PLN)',
        'Przychód netto (PLN)',
        'Liczba płatności'
      ];
      const lines = [header.join(';')];

      (payload.byProvider || []).forEach((p) => {
        const row = [
          p.providerName || '',
          ((p.totalRevenue || 0) / 100).toFixed(2),
          ((p.platformFees || 0) / 100).toFixed(2),
          ((p.netRevenue || 0) / 100).toFixed(2),
          p.paymentCount || 0
        ];
        lines.push(row.join(';'));
      });

      return res.send(lines.join('\n'));
    }

    res.json(payload);
  } catch (error) {
    logger.error('COMPANY_BILLING_SUMMARY_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania rozliczeń' });
  }
});

// GET /api/companies/:companyId/billing/invoices - Lista faktur
router.get('/:companyId/billing/invoices', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const CompanyInvoice = require('../models/CompanyInvoice');
    const companyIdToUse = req.companyId || req.params.companyId || req.company?._id;
    
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
    logger.error('COMPANY_INVOICES_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktur', error: error.message });
  }
});

// GET /api/companies/:companyId/invoices - Lista faktur (alternatywny endpoint - używa CompanyInvoice)
router.get('/:companyId/invoices', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    logger.debug('[COMPANY_INVOICES] Request received:', {
      companyId: req.params.companyId,
      reqCompanyId: req.companyId,
      reqCompany: req.company?._id
    });
    
    const CompanyInvoice = require('../models/CompanyInvoice');
    const companyIdToUse = req.companyId || req.params.companyId || req.company?._id;
    
    logger.debug('[COMPANY_INVOICES] Using companyId:', companyIdToUse);

    if (!companyIdToUse) {
      logger.warn('[COMPANY_INVOICES] No companyId found');
      return res.status(400).json({ 
        success: false,
        message: 'Brak ID firmy' 
      });
    }

    const invoices = await CompanyInvoice.find({ company: companyIdToUse })
      .sort({ createdAt: -1 })
      .lean();
    
    logger.debug('[COMPANY_INVOICES] Found invoices:', invoices.length);

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
    logger.error('COMPANY_INVOICES_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktur', error: error.message });
  }
});

// GET /api/companies/:companyId/orders/invoices - Lista faktur zleceń od providerów firmy
router.get('/:companyId/orders/invoices', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = req.company;
    const { from, to, providerId } = req.query;
    
    // Pobierz wszystkich providerów firmy
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];
    
    // Query dla zleceń z fakturami
    const query = {
      provider: { $in: companyProviders },
      'invoice.url': { $exists: true, $ne: null }
    };
    
    // Filtrowanie po providerze (jeśli podano)
    if (providerId) {
      query.provider = providerId;
    }
    
    // Filtrowanie po dacie (jeśli podano)
    if (from || to) {
      query['invoice.uploadedAt'] = {};
      if (from) {
        query['invoice.uploadedAt'].$gte = new Date(from);
      }
      if (to) {
        query['invoice.uploadedAt'].$lte = new Date(to);
      }
    }
    
    const orders = await Order.find(query)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .select('service description status invoice createdAt completedAt')
      .sort({ 'invoice.uploadedAt': -1 })
      .lean();
    
    res.json({
      success: true,
      invoices: orders.map(order => ({
        orderId: order._id,
        orderService: order.service,
        orderDescription: order.description,
        orderStatus: order.status,
        client: {
          name: order.client?.name || order.client?.email,
          email: order.client?.email
        },
        provider: {
          name: order.provider?.name || order.provider?.email,
          email: order.provider?.email
        },
        invoice: {
          url: order.invoice.url,
          filename: order.invoice.filename,
          size: order.invoice.size,
          uploadedAt: order.invoice.uploadedAt,
          sentToClient: order.invoice.sentToClient
        },
        completedAt: order.completedAt,
        createdAt: order.createdAt
      })),
      total: orders.length
    });
  } catch (error) {
    logger.error('COMPANY_ORDERS_INVOICES_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktur zleceń', error: error.message });
  }
});

// GET /api/companies/:companyId/billing/helpfli-invoices - Lista faktur Helpfli dla firmy
router.get('/:companyId/billing/helpfli-invoices', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = req.company;
    const { from, to } = req.query;
    
    // Pobierz wszystkich providerów firmy
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];
    
    // Query dla płatności z fakturami Helpfli
    const query = {
      $or: [
        { subscriptionUser: { $in: companyProviders } },
        { provider: { $in: companyProviders } },
        { client: { $in: companyProviders } }
      ],
      invoice: { $exists: true, $ne: null },
      purpose: { $in: ['subscription', 'promotion'] }
    };
    
    // Filtrowanie po dacie (jeśli podano)
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    
    const Payment = require('../models/Payment');
    const Invoice = require('../models/Invoice');
    
    const payments = await Payment.find(query)
      .populate('subscriptionUser', 'name email')
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .populate('invoice')
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({
      success: true,
      invoices: payments
        .filter(p => p.invoice)
        .map(p => ({
          paymentId: p._id,
          purpose: p.purpose,
          amount: p.amount,
          currency: p.currency,
          createdAt: p.createdAt,
          user: p.subscriptionUser || p.provider || p.client,
          invoice: {
            _id: p.invoice._id,
            invoiceNumber: p.invoice.invoiceNumber,
            issuedAt: p.invoice.issuedAt,
            status: p.invoice.status,
            total: p.invoice.summary?.total,
            currency: p.invoice.summary?.currency,
            pdfUrl: p.invoice.pdfUrl
          },
          subscriptionPlanKey: p.subscriptionPlanKey,
          metadata: p.metadata
        })),
      total: payments.filter(p => p.invoice).length
    });
  } catch (error) {
    logger.error('COMPANY_HELPFLI_INVOICES_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktur Helpfli', error: error.message });
  }
});

// Uwaga: Endpoint generowania faktur został usunięty
// Faktury są teraz wystawiane przez KSeF
// Firmy mogą pobierać rozliczenia (settlements) do własnych celów księgowych

module.exports = router;








