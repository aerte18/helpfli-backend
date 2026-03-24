?const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const User = require('../models/User');
const Order = require('../models/Order');
const Service = require('../models/Service');
const Rating = require('../models/Rating');
const Message = require('../models/Message');
const Invoice = require('../models/Invoice');
const CompanyInvoice = require('../models/CompanyInvoice');
const Company = require('../models/Company');
const Payment = require('../models/Payment');
const NotificationService = require('../services/NotificationService');
const { validateNIP } = require('../utils/companyValidation');
const { recomputeTopAiBadge } = require("../utils/topAiBadge");

const router = express.Router();

// Zabezpieczenie – tylko admin
router.use(authMiddleware, adminMiddleware);

// Lista wszystkich użytkowników
router.get('/users', async (req, res) => {
  const users = await User.find().select('-password');
  res.json(users);
});

// Lista wszystkich zleceń
router.get('/orders', async (req, res) => {
  const orders = await Order.find().populate('client provider service');
  res.json(orders);
});

// Lista wszystkich usług
router.get('/services', async (req, res) => {
  const services = await Service.find();
  res.json(services);
});

// Dodaj nową usługę
router.post('/services', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'Brak nazwy usługi' });

  const existing = await Service.findOne({ name });
  if (existing) return res.status(400).json({ message: 'Usługa już istnieje' });

  const service = await Service.create({ name });
  res.status(201).json(service);
});

// Usuń usługę
router.delete('/services/:id', async (req, res) => {
  await Service.findByIdAndDelete(req.params.id);
  res.json({ message: 'Usługa usunięta' });
});

// Lista wszystkich ocen
router.get('/ratings', async (req, res) => {
  const ratings = await Rating.find().populate('from to');
  res.json(ratings);
});

// Wszystkie wiadomości (opcjonalnie)
router.get('/messages', async (req, res) => {
  const messages = await Message.find().populate('from to');
  res.json(messages);
});

/**
 * POST /api/admin/recompute-top-ai
 * (wymaga uprawnień admina — poniżej najprostsza kontrola)
 */
router.post("/recompute-top-ai", authMiddleware, async (req, res) => {
  try {
    if (!req.user?.isAdmin) return res.status(403).json({ message: "Brak uprawnień" });

    const providers = await User.find({ role: "provider" }, { _id: 1 }).lean();
    const out = [];
    for (const p of providers) {
      const r = await recomputeTopAiBadge(p._id);
      out.push({ providerId: p._id, ...r });
    }
    res.json({ processed: out.length, results: out });
  } catch (e) {
    console.error("recompute-top-ai error:", e);
    res.status(500).json({ message: "Błąd przeliczenia TOP AI" });
  }
});

// POST /api/admin/invoices/create - Admin ręcznie wystawia fakturę
router.post('/invoices/create', async (req, res) => {
  try {
    const { 
      ownerType, // 'user' lub 'company'
      ownerId,   // ID użytkownika lub firmy
      orderId,   // Opcjonalnie - ID zlecenia
      paymentId, // Opcjonalnie - ID płatności
      buyer,     // Dane nabywcy { name, email, nip?, address }
      items,     // Pozycje faktury [{ description, quantity, unitPrice, totalPrice }]
      taxRate = 23, // VAT rate
      notes      // Notatki
    } = req.body;

    if (!ownerType || !ownerId || !buyer || !items || items.length === 0) {
      return res.status(400).json({ 
        message: 'Brak wymaganych pól: ownerType, ownerId, buyer, items' 
      });
    }

    // Walidacja ownerType
    if (!['user', 'company'].includes(ownerType)) {
      return res.status(400).json({ message: 'ownerType musi być "user" lub "company"' });
    }

    // Sprawdź czy owner istnieje
    if (ownerType === 'user') {
      const user = await User.findById(ownerId);
      if (!user) {
        return res.status(404).json({ message: 'Użytkownik nie został znaleziony' });
      }
    } else {
      const company = await Company.findById(ownerId);
      if (!company) {
        return res.status(404).json({ message: 'Firma nie została znaleziona' });
      }
    }

    // Walidacja NIP dla firm B2B
    if (buyer.nip) {
      const nipValidation = validateNIP(buyer.nip);
      if (!nipValidation.valid) {
        return res.status(400).json({ 
          message: `Nieprawidłowy NIP: ${nipValidation.error}` 
        });
      }
    }

    // Oblicz podsumowanie
    const subtotal = items.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
    const taxAmount = Math.round(subtotal * (taxRate / 100));
    const total = subtotal + taxAmount;

    // Utwórz fakturę
    const saleDate = new Date();
    const dueDate = new Date(saleDate);
    dueDate.setDate(dueDate.getDate() + 14); // 14 dni

    if (ownerType === 'company') {
      // Faktura dla firmy (CompanyInvoice)
      const company = await Company.findById(ownerId);
      const invoice = await CompanyInvoice.create({
        company: ownerId,
        type: 'manual',
        period: {
          startDate: saleDate,
          endDate: saleDate
        },
        companyData: {
          name: company.name,
          nip: company.nip,
          address: company.address || {}
        },
        items: items.map(item => ({
          description: item.description,
          quantity: item.quantity || 1,
          unitPrice: Math.round(item.unitPrice || 0),
          totalPrice: Math.round(item.totalPrice || 0),
          orderId: orderId || null,
          paymentId: paymentId || null,
          metadata: {}
        })),
        summary: {
          subtotal,
          taxRate,
          taxAmount,
          total,
          currency: 'PLN'
        },
        status: 'issued',
        issuedAt: saleDate,
        dueDate,
        notes: notes || ''
      });

      // Powiadom właściciela firmy
      try {
        await NotificationService.sendNotification(
          'company_invoice_generated',
          [company.owner],
          {
            companyName: company.name,
            invoiceNumber: invoice.invoiceNumber,
            amount: (total / 100).toFixed(2)
          }
        );
      } catch (notifyErr) {
        console.error('ADMIN_INVOICE_NOTIFICATION_ERROR:', notifyErr);
      }

      res.json({
        success: true,
        message: 'Faktura została wystawiona',
        invoice: {
          _id: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          type: invoice.type,
          summary: {
            ...invoice.summary,
            totalFormatted: `${(invoice.summary.total / 100).toFixed(2)} PLN`
          },
          status: invoice.status,
          issuedAt: invoice.issuedAt,
          dueDate: invoice.dueDate
        }
      });
    } else {
      // Faktura dla użytkownika (Invoice)
      const invoice = await Invoice.create({
        ownerType: 'user',
        owner: ownerId,
        source: 'manual',
        order: orderId || null,
        payment: paymentId || null,
        saleDate,
        dueDate,
        buyer: {
          name: buyer.name,
          email: buyer.email || '',
          nip: buyer.nip || '',
          address: buyer.address || {
            street: '',
            city: '',
            postalCode: '',
            country: 'Polska'
          }
        },
        seller: {
          name: process.env.INVOICE_SELLER_NAME || 'Helpfli Sp. z o.o.',
          nip: process.env.INVOICE_SELLER_NIP || '',
          address: {
            street: process.env.INVOICE_SELLER_STREET || '',
            city: process.env.INVOICE_SELLER_CITY || '',
            postalCode: process.env.INVOICE_SELLER_POSTAL || '',
            country: process.env.INVOICE_SELLER_COUNTRY || 'Polska'
          }
        },
        items: items.map(item => ({
          description: item.description,
          quantity: item.quantity || 1,
          unitPrice: Math.round(item.unitPrice || 0),
          totalPrice: Math.round(item.totalPrice || 0)
        })),
        summary: {
          subtotal,
          taxRate,
          taxAmount,
          total,
          currency: (process.env.CURRENCY || 'pln').toUpperCase()
        },
        status: 'issued',
        metadata: {
          generatedManually: true,
          createdByAdmin: req.user._id,
          notes: notes || ''
        }
      });

      // Powiadom użytkownika
      try {
        await NotificationService.sendNotification(
          'client_invoice_issued',
          [ownerId],
          {
            clientName: buyer.name,
            invoiceNumber: invoice.invoiceNumber,
            amount: (total / 100).toFixed(2)
          }
        );
      } catch (notifyErr) {
        console.error('ADMIN_INVOICE_NOTIFICATION_ERROR:', notifyErr);
      }

      res.json({
        success: true,
        message: 'Faktura została wystawiona',
        invoice: invoice.toClientJSON ? invoice.toClientJSON() : {
          _id: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          summary: {
            ...invoice.summary,
            totalFormatted: `${(invoice.summary.total / 100).toFixed(2)} PLN`
          },
          status: invoice.status,
          issuedAt: invoice.issuedAt,
          dueDate: invoice.dueDate
        }
      });
    }
  } catch (error) {
    console.error('ADMIN_CREATE_INVOICE_ERROR:', error);
    res.status(500).json({ 
      message: 'Błąd wystawiania faktury', 
      error: error.message 
    });
  }
});

// GET /api/admin/payments/pending-invoices - Lista płatności oczekujących na fakturę
router.get('/payments/pending-invoices', async (req, res) => {
  try {
    const { purpose, from, to } = req.query;
    
    const query = {
      requestInvoice: true,
      invoice: null, // Nie ma jeszcze faktury
      status: 'succeeded'
    };
    
    if (purpose) {
      query.purpose = purpose; // 'subscription', 'promotion'
    }
    
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    
    const payments = await Payment.find(query)
      .populate('subscriptionUser', 'name email billing')
      .populate('client', 'name email billing')
      .populate('provider', 'name email billing')
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({
      success: true,
      payments: payments.map(p => ({
        _id: p._id,
        purpose: p.purpose,
        amount: p.amount,
        currency: p.currency,
        createdAt: p.createdAt,
        subscriptionUser: p.subscriptionUser ? {
          _id: p.subscriptionUser._id,
          name: p.subscriptionUser.name,
          email: p.subscriptionUser.email,
          billing: p.subscriptionUser.billing
        } : null,
        client: p.client ? {
          _id: p.client._id,
          name: p.client.name,
          email: p.client.email,
          billing: p.client.billing
        } : null,
        provider: p.provider ? {
          _id: p.provider._id,
          name: p.provider.name,
          email: p.provider.email,
          billing: p.provider.billing
        } : null,
        subscriptionPlanKey: p.subscriptionPlanKey,
        metadata: p.metadata
      })),
      total: payments.length
    });
  } catch (error) {
    console.error('ADMIN_PENDING_INVOICES_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania płatności oczekujących na fakturę', error: error.message });
  }
});

// POST /api/admin/payments/:paymentId/create-invoice - Wystaw fakturę za płatność Helpfli
router.post('/payments/:paymentId/create-invoice', async (req, res) => {
  try {
    const { paymentId } = req.params;
    
    const payment = await Payment.findById(paymentId)
      .populate('subscriptionUser', 'name email billing')
      .populate('client', 'name email billing')
      .populate('provider', 'name email billing');
    
    if (!payment) {
      return res.status(404).json({ message: 'Płatność nie znaleziona' });
    }
    
    if (!payment.requestInvoice) {
      return res.status(400).json({ message: 'Ta płatność nie wymaga faktury' });
    }
    
    if (payment.invoice) {
      return res.status(400).json({ message: 'Faktura dla tej płatności już istnieje', invoiceId: payment.invoice });
    }
    
    if (payment.status !== 'succeeded') {
      return res.status(400).json({ message: 'Tylko udane płatności mogą mieć fakturę' });
    }
    
    // Określ właściciela faktury
    let owner = null;
    let ownerType = 'user';
    let buyerData = null;
    
    if (payment.purpose === 'subscription' && payment.subscriptionUser) {
      owner = payment.subscriptionUser;
      ownerType = 'user';
    } else if (payment.client) {
      owner = payment.client;
      ownerType = 'user';
    } else if (payment.provider) {
      owner = payment.provider;
      ownerType = 'user';
    } else {
      return res.status(400).json({ message: 'Nie można określić właściciela faktury' });
    }
    
    // Przygotuj dane nabywcy
    const customerType = owner.billing?.customerType || 'individual';
    const buyerName = customerType === 'company' 
      ? (owner.billing?.companyName || owner.name || owner.email)
      : (owner.name || owner.email);
    
    buyerData = {
      name: buyerName,
      email: owner.email,
      nip: customerType === 'company' ? (owner.billing?.nip || '') : '',
      address: {
        street: owner.billing?.street || '',
        city: owner.billing?.city || '',
        postalCode: owner.billing?.postalCode || '',
        country: owner.billing?.country || 'Polska'
      }
    };
    
    // Walidacja NIP dla firm B2B
    if (customerType === 'company' && !buyerData.nip) {
      return res.status(400).json({ 
        message: 'NIP jest wymagany dla faktur B2B. Uzupełnij dane w ustawieniach konta.' 
      });
    }
    
    if (buyerData.nip) {
      const nipValidation = validateNIP(buyerData.nip);
      if (!nipValidation.valid) {
        return res.status(400).json({ 
          message: `Nieprawidłowy NIP: ${nipValidation.error}` 
        });
      }
    }
    
    // Przygotuj opis pozycji faktury
    let itemDescription = '';
    if (payment.purpose === 'subscription') {
      const SubscriptionPlan = require('../models/SubscriptionPlan');
      const plan = await SubscriptionPlan.findOne({ key: payment.subscriptionPlanKey });
      itemDescription = plan ? `Subskrypcja ${plan.name}` : `Subskrypcja ${payment.subscriptionPlanKey || ''}`;
    } else if (payment.purpose === 'promotion') {
      itemDescription = payment.metadata?.description || 'Promowanie oferty / Boost';
    } else {
      itemDescription = 'Usługa Helpfli';
    }
    
    // Oblicz kwoty (kwota jest już w groszach, brutto)
    const grossAmount = payment.amount;
    const taxRate = 23;
    const subtotal = Math.round(grossAmount / (1 + taxRate / 100));
    const taxAmount = grossAmount - subtotal;
    
    const saleDate = payment.createdAt || new Date();
    const dueDate = new Date(saleDate);
    dueDate.setDate(dueDate.getDate() + 14);
    
    // Utwórz fakturę
    const invoice = await Invoice.create({
      ownerType,
      owner: owner._id,
      source: payment.purpose === 'subscription' ? 'subscription' : 'promotion',
      payment: payment._id,
      saleDate,
      dueDate,
      buyer: buyerData,
      seller: {
        name: process.env.INVOICE_SELLER_NAME || 'Helpfli Sp. z o.o.',
        nip: process.env.INVOICE_SELLER_NIP || '',
        address: {
          street: process.env.INVOICE_SELLER_STREET || '',
          city: process.env.INVOICE_SELLER_CITY || '',
          postalCode: process.env.INVOICE_SELLER_POSTAL || '',
          country: process.env.INVOICE_SELLER_COUNTRY || 'Polska'
        }
      },
      items: [{
        description: itemDescription,
        quantity: 1,
        unitPrice: subtotal,
        totalPrice: subtotal
      }],
      summary: {
        subtotal,
        taxRate,
        taxAmount,
        total: grossAmount,
        currency: (payment.currency || 'pln').toUpperCase()
      },
      status: 'issued',
      metadata: {
        generatedByAdmin: true,
        paymentPurpose: payment.purpose,
        subscriptionPlanKey: payment.subscriptionPlanKey,
        customerType
      }
    });
    
    // Zaktualizuj payment z fakturą
    payment.invoice = invoice._id;
    await payment.save();
    
    // Wyślij powiadomienie do użytkownika
    try {
      await NotificationService.sendEmail(
        owner.email,
        'Faktura została wystawiona',
        `Faktura ${invoice.invoiceNumber} została wystawiona za płatność ${itemDescription}.`,
        {
          invoiceNumber: invoice.invoiceNumber,
          amount: (invoice.summary.total / 100).toFixed(2),
          currency: invoice.summary.currency
        }
      );
    } catch (notifyErr) {
      console.error('ADMIN_INVOICE_NOTIFICATION_ERROR:', notifyErr);
    }
    
    res.json({
      success: true,
      invoice: {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        ownerType: invoice.ownerType,
        owner: invoice.owner,
        source: invoice.source,
        amount: invoice.summary.total,
        currency: invoice.summary.currency,
        status: invoice.status,
        issuedAt: invoice.issuedAt
      }
    });
  } catch (error) {
    console.error('ADMIN_CREATE_PAYMENT_INVOICE_ERROR:', error);
    res.status(500).json({ message: 'Błąd wystawiania faktury', error: error.message });
  }
});

// GET /api/admin/invoices - Lista wszystkich faktur (użytkowników i firm)
router.get('/invoices', async (req, res) => {
  try {
    const { limit = 100, offset = 0, ownerType, status } = req.query;
    
    const query = {};
    if (ownerType) {
      query.ownerType = ownerType;
    }
    if (status) {
      query.status = status;
    }

    // Pobierz faktury użytkowników
    const userInvoices = await Invoice.find(query)
      .populate('owner', 'name email')
      .sort({ issuedAt: -1 })
      .limit(parseInt(limit, 10))
      .skip(parseInt(offset, 10))
      .lean();

    // Pobierz faktury firm
    const companyInvoices = await CompanyInvoice.find({})
      .populate('company', 'name nip')
      .sort({ issuedAt: -1 })
      .limit(parseInt(limit, 10))
      .skip(parseInt(offset, 10))
      .lean();

    // Połącz i posortuj
    const allInvoices = [
      ...userInvoices.map(inv => ({
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        ownerType: 'user',
        owner: inv.owner ? { _id: inv.owner._id, name: inv.owner.name, email: inv.owner.email } : null,
        summary: inv.summary,
        status: inv.status,
        issuedAt: inv.issuedAt,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        createdAt: inv.createdAt
      })),
      ...companyInvoices.map(inv => ({
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        ownerType: 'company',
        owner: inv.company ? { _id: inv.company._id, name: inv.company.name, email: null } : null,
        summary: inv.summary,
        status: inv.status,
        issuedAt: inv.issuedAt,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        createdAt: inv.createdAt
      }))
    ].sort((a, b) => new Date(b.issuedAt || b.createdAt) - new Date(a.issuedAt || a.createdAt));

    res.json({
      success: true,
      invoices: allInvoices,
      total: allInvoices.length
    });
  } catch (error) {
    console.error('ADMIN_INVOICES_LIST_ERROR:', error);
    res.status(500).json({ 
      success: false,
      message: 'Błąd pobierania faktur', 
      error: error.message 
    });
  }
});

module.exports = router;