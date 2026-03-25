const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const PDFDocument = require('pdfkit');
const NotificationService = require('../services/NotificationService');
const { validateNIP } = require('../utils/companyValidation');

// GET /api/billing/invoices - lista faktur zalogowanego użytkownika (klienta)
router.get('/invoices', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const query = {
      ownerType: 'user',
      owner: req.user._id
    };

    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .sort({ issuedAt: -1 })
        .limit(parseInt(limit, 10))
        .skip(parseInt(offset, 10)),
      Invoice.countDocuments(query)
    ]);

    res.json({
      success: true,
      invoices: invoices.map(inv => inv.toClientJSON()),
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (error) {
    console.error('USER_INVOICES_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktur' });
  }
});

// GET /api/billing/invoices/:id/pdf - pobierz PDF
router.get('/invoices/:id/pdf', authMiddleware, async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      ownerType: 'user',
      owner: req.user._id
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
        `Data sprzedaży: ${invoice.saleDate?.toLocaleDateString('pl-PL') || invoice.issuedAt?.toLocaleDateString('pl-PL') || ''}`,
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
      .text(invoice.seller?.name || 'Helpfli')
      .text(invoice.seller?.address?.street || '')
      .text(
        `${invoice.seller?.address?.postalCode || ''} ${
          invoice.seller?.address?.city || ''
        }`
      )
      .text(`NIP: ${invoice.seller?.nip || '-'}`)
      .moveDown(1);

    doc
      .fontSize(11)
      .text('Nabywca:', { continued: false })
      .fontSize(10)
      .text(invoice.buyer?.name || '')
      .text(invoice.buyer?.address?.street || '')
      .text(
        `${invoice.buyer?.address?.postalCode || ''} ${
          invoice.buyer?.address?.city || ''
        }`
      )
      .text(
        invoice.buyer?.nip ? `NIP: ${invoice.buyer.nip}` : 'NIP: -'
      )
      .moveDown(1.5);

    // Tabela pozycji (prosta lista)
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
    console.error('USER_INVOICE_PDF_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania faktury' });
  }
});

// GET /api/billing/invoices/uninvoiced-orders - lista opłaconych zleceń bez faktury
router.get('/invoices/uninvoiced-orders', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({
      client: req.user._id,
      paymentStatus: 'succeeded'
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Sprawdź które zlecenia nie mają faktury
    const orderIds = orders.map(o => o._id);
    const existingInvoices = await Invoice.find({
      ownerType: 'user',
      owner: req.user._id,
      source: 'order',
      order: { $in: orderIds }
    }).select('order').lean();

    const invoicedOrderIds = new Set(existingInvoices.map(inv => String(inv.order)));
    const uninvoicedOrders = orders.filter(o => !invoicedOrderIds.has(String(o._id)));

    res.json({
      success: true,
      orders: uninvoicedOrders.map(order => ({
        _id: order._id,
        service: order.service,
        amountTotal: order.amountTotal || order.pricing?.total || 0,
        createdAt: order.createdAt,
        paymentStatus: order.paymentStatus
      }))
    });
  } catch (error) {
    console.error('UNINVOICED_ORDERS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania zleceń bez faktury' });
  }
});

// POST /api/billing/invoices/create-manual - ręczne wystawienie faktury dla zlecenia
router.post('/invoices/create-manual', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: 'Brak orderId' });
    }

    // Sprawdź czy zlecenie istnieje i należy do klienta
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Zlecenie nie znalezione' });
    }

    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Brak uprawnień do tego zlecenia' });
    }

    // Sprawdź czy zlecenie jest opłacone
    if (order.paymentStatus !== 'succeeded') {
      return res.status(400).json({ message: 'Zlecenie nie jest opłacone' });
    }

    // Sprawdź czy faktura już istnieje
    const existingInvoice = await Invoice.findOne({
      ownerType: 'user',
      owner: req.user._id,
      source: 'order',
      order: order._id
    });

    if (existingInvoice) {
      return res.status(400).json({ 
        message: 'Faktura dla tego zlecenia już istnieje',
        invoiceId: existingInvoice._id
      });
    }

    // Pobierz dane klienta
    const client = await User.findById(req.user._id);
    if (!client) {
      return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    }

    // Walidacja dla firm B2B - NIP jest wymagany
    const customerType = client.billing?.customerType || 'individual';
    if (customerType === 'company') {
      if (!client.billing?.nip) {
        return res.status(400).json({ 
          message: 'NIP jest wymagany dla faktur B2B. Uzupełnij dane w ustawieniach konta.' 
        });
      }
      const nipValidation = validateNIP(client.billing.nip);
      if (!nipValidation.valid) {
        return res.status(400).json({ 
          message: `Nieprawidłowy NIP: ${nipValidation.error}` 
        });
      }
    }

    // Pobierz płatność
    const payment = order.paymentId ? await Payment.findById(order.paymentId) : null;

    // Oblicz kwoty
    const grossAmount = order.amountTotal || order.pricing?.total || 0;
    const taxRate = 23;
    const subtotal = Math.round(grossAmount / (1 + taxRate / 100));
    const taxAmount = grossAmount - subtotal;

    const buyerName = customerType === 'company'
      ? (client.billing?.companyName || client.name || client.email)
      : (client.name || client.email);

    const saleDate = order.createdAt || new Date();
    const dueDate = new Date(saleDate);
    dueDate.setDate(dueDate.getDate() + 14);

    // Utwórz fakturę
    const invoice = await Invoice.create({
      ownerType: 'user',
      owner: client._id,
      source: 'order',
      order: order._id,
      payment: order.paymentId || null,
      saleDate,
      dueDate,
      buyer: {
        name: buyerName,
        email: client.email,
        nip: customerType === 'company' ? (client.billing?.nip || '') : '',
        address: {
          street: client.billing?.street || '',
          city: client.billing?.city || '',
          postalCode: client.billing?.postalCode || '',
          country: client.billing?.country || 'Polska'
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
      items: [
        {
          description: order.service || 'Usługa Helpfli',
          quantity: 1,
          unitPrice: subtotal,
          totalPrice: subtotal
        }
      ],
      summary: {
        subtotal,
        taxRate,
        taxAmount,
        total: grossAmount,
        currency: (process.env.CURRENCY || 'pln').toUpperCase()
      },
      status: 'issued',
      metadata: {
        generatedManually: true,
        customerType,
        invoiceMode: client.billing?.invoiceMode || 'per_order'
      }
    });

    // Wyślij powiadomienie
    try {
      await NotificationService.sendNotification(
        'client_invoice_issued',
        [client._id],
        {
          clientName: client.name || client.email,
          service: order.service || 'Usługa Helpfli',
          orderId: order._id,
          invoiceNumber: invoice.invoiceNumber
        }
      );
    } catch (notifyErr) {
      console.error('client_invoice_issued notification error:', notifyErr);
    }

    res.json({
      success: true,
      invoice: invoice.toClientJSON()
    });
  } catch (error) {
    console.error('CREATE_MANUAL_INVOICE_ERROR:', error);
    res.status(500).json({ message: 'Błąd wystawiania faktury', error: error.message });
  }
});

module.exports = router;


