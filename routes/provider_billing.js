const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const dayjs = require('dayjs');
const Payment = require('../models/Payment');
const ProviderSettlement = require('../models/ProviderSettlement');
const User = require('../models/User');

// Upewnij się, że użytkownik jest providerem (indywidualnym)
function requireProvider(req, res, next) {
  if (!req.user || req.user.role !== 'provider') {
    return res.status(403).json({ message: 'Dostęp tylko dla wykonawców' });
  }
  next();
}

// GET /api/providers/billing/settlements - lista rozliczeń providera
router.get('/settlements', authMiddleware, requireProvider, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const query = { provider: req.user._id };
    const [rows, total] = await Promise.all([
      ProviderSettlement.find(query)
        .sort({ periodFrom: -1 })
        .limit(parseInt(limit, 10))
        .skip(parseInt(offset, 10))
        .populate('selfBillingInvoice', 'invoiceNumber')
        .lean(),
      ProviderSettlement.countDocuments(query)
    ]);

    res.json({
      success: true,
      settlements: rows.map((s) => ({
        ...s,
        totalRevenueFormatted: (s.totalRevenue / 100).toFixed(2) + ' zł',
        platformFeesFormatted: (s.platformFees / 100).toFixed(2) + ' zł',
        netRevenueFormatted: (s.netRevenue / 100).toFixed(2) + ' zł',
        period: {
          from: dayjs(s.periodFrom).format('YYYY-MM-DD'),
          to: dayjs(s.periodTo).format('YYYY-MM-DD')
        },
        selfBillingInvoice: s.selfBillingInvoice || null
      })),
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (error) {
    console.error('PROVIDER_SETTLEMENTS_LIST_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania rozliczeń' });
  }
});

// GET /api/providers/billing/settlements/export - eksport CSV wszystkich rozliczeń providera
router.get('/settlements/export', authMiddleware, requireProvider, async (req, res) => {
  try {
    const settlements = await ProviderSettlement.find({ provider: req.user._id })
      .sort({ periodFrom: -1 })
      .lean();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=helpfli_rozliczenia_provider.csv');

    const header = [
      'Okres od',
      'Okres do',
      'Przychód brutto (PLN)',
      'Prowizja Helpfli (PLN)',
      'Przychód netto (PLN)',
      'Liczba płatności',
      'Status',
      'Numer faktury providera'
    ];

    const lines = [header.join(';')];

    settlements.forEach((s) => {
      const row = [
        dayjs(s.periodFrom).format('YYYY-MM-DD'),
        dayjs(s.periodTo).format('YYYY-MM-DD'),
        (s.totalRevenue / 100).toFixed(2),
        (s.platformFees / 100).toFixed(2),
        (s.netRevenue / 100).toFixed(2),
        s.paymentCount || 0,
        s.status || '',
        s.invoiceNumberFromProvider || ''
      ];
      lines.push(row.join(';'));
    });

    res.send(lines.join('\n'));
  } catch (error) {
    console.error('PROVIDER_SETTLEMENTS_EXPORT_ERROR:', error);
    res.status(500).json({ message: 'Błąd eksportu rozliczeń' });
  }
});

// POST /api/providers/billing/self-billing/enable - włącz samofakturowanie
router.post('/self-billing/enable', authMiddleware, requireProvider, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    }

    user.selfBillingEnabled = true;
    user.selfBillingAgreementAcceptedAt = new Date();
    await user.save();

    res.json({ ok: true, selfBillingEnabled: true });
  } catch (error) {
    console.error('PROVIDER_SELF_BILLING_ENABLE_ERROR:', error);
    res.status(500).json({ message: 'Błąd włączania samofakturowania' });
  }
});

// POST /api/providers/billing/self-billing/disable - wyłącz samofakturowanie
router.post('/self-billing/disable', authMiddleware, requireProvider, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    }

    user.selfBillingEnabled = false;
    await user.save();

    res.json({ ok: true, selfBillingEnabled: false });
  } catch (error) {
    console.error('PROVIDER_SELF_BILLING_DISABLE_ERROR:', error);
    res.status(500).json({ message: 'Błąd wyłączania samofakturowania' });
  }
});

// POST /api/providers/billing/settlements/generate - wygeneruj rozliczenie za okres
router.post('/settlements/generate', authMiddleware, requireProvider, async (req, res) => {
  try {
    const { from, to } = req.body || {};
    const periodFrom = from ? dayjs(from).startOf('day') : dayjs().startOf('month');
    const periodTo = to ? dayjs(to).endOf('day') : dayjs().endOf('month');

    const start = periodFrom.toDate();
    const end = periodTo.toDate();

    // Sprawdź, czy rozliczenie dla takiego okresu już istnieje
    const existing = await ProviderSettlement.findOne({
      provider: req.user._id,
      periodFrom: start,
      periodTo: end
    });
    if (existing) {
      return res.json({
        success: true,
        settlement: existing
      });
    }

    // Zbierz płatności z tego okresu
    const payments = await Payment.find({
      provider: req.user._id,
      status: 'succeeded',
      createdAt: { $gte: start, $lte: end }
    }).lean();

    if (payments.length === 0) {
      return res.status(400).json({ message: 'Brak opłaconych zleceń w tym okresie' });
    }

    const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const platformFees = payments.reduce(
      (sum, p) => sum + (p.platformFeeAmount || 0),
      0
    );
    const netRevenue = totalRevenue - platformFees;

    const settlement = await ProviderSettlement.create({
      provider: req.user._id,
      periodFrom: start,
      periodTo: end,
      totalRevenue,
      platformFees,
      netRevenue,
      currency: (payments[0]?.currency || 'pln').toUpperCase(),
      paymentCount: payments.length,
      paymentIds: payments.map((p) => p._id)
    });

    res.json({
      success: true,
      settlement
    });
  } catch (error) {
    console.error('PROVIDER_SETTLEMENT_GENERATE_ERROR:', error);
    res.status(500).json({ message: 'Błąd generowania rozliczenia' });
  }
});

// POST /api/providers/billing/settlements/:id/invoice - zapis numeru faktury od providera
router.post(
  '/settlements/:id/invoice',
  authMiddleware,
  requireProvider,
  async (req, res) => {
    try {
      const { invoiceNumber } = req.body || {};
      if (!invoiceNumber) {
        return res.status(400).json({ message: 'Numer faktury jest wymagany' });
      }

      const settlement = await ProviderSettlement.findOne({
        _id: req.params.id,
        provider: req.user._id
      });

      if (!settlement) {
        return res.status(404).json({ message: 'Rozliczenie nie zostało znalezione' });
      }

      settlement.invoiceNumberFromProvider = invoiceNumber;
      settlement.status = 'invoiced';
      await settlement.save();

      res.json({
        success: true,
        message: 'Numer faktury zapisany',
        settlement
      });
    } catch (error) {
      console.error('PROVIDER_SETTLEMENT_INVOICE_ERROR:', error);
      res.status(500).json({ message: 'Błąd zapisu numeru faktury' });
    }
  }
);

module.exports = router;


