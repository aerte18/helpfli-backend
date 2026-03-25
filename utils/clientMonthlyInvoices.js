const dayjs = require('dayjs');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const NotificationService = require('../services/NotificationService');

/**
 * Generuje miesięczne faktury zbiorcze dla klientów z trybem monthly
 * @param {Date} periodStart - Data początku okresu (pierwszy dzień miesiąca)
 * @param {Date} periodEnd - Data końca okresu (ostatni dzień miesiąca)
 */
async function generateMonthlyInvoices(periodStart, periodEnd) {
  const start = dayjs(periodStart).startOf('day').toDate();
  const end = dayjs(periodEnd).endOf('day').toDate();

  console.log(
    '[ClientMonthlyInvoices] Generating monthly invoices for period',
    dayjs(start).format('YYYY-MM-DD'),
    '–',
    dayjs(end).format('YYYY-MM-DD')
  );

  // Znajdź wszystkich klientów z trybem monthly, którzy mają opłacone zlecenia bez faktury w tym okresie
  const clientsWithMonthlyMode = await User.find({
    role: 'client',
    'billing.invoiceMode': 'monthly',
    'billing.wantInvoice': true
  }).lean();

  if (!clientsWithMonthlyMode.length) {
    console.log('[ClientMonthlyInvoices] No clients with monthly invoice mode');
    return { generated: 0, errors: [] };
  }

  let generated = 0;
  const errors = [];

  for (const client of clientsWithMonthlyMode) {
    try {
      // Znajdź wszystkie opłacone zlecenia klienta w tym okresie, które nie mają jeszcze faktury
      const orders = await Order.find({
        client: client._id,
        paymentStatus: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }).lean();

      if (!orders.length) {
        continue; // Brak zleceń do fakturowania
      }

      // Sprawdź które zlecenia nie mają jeszcze faktury
      const orderIds = orders.map(o => o._id);
      const existingInvoices = await Invoice.find({
        ownerType: 'user',
        owner: client._id,
        source: 'order',
        order: { $in: orderIds }
      }).select('order').lean();

      const invoicedOrderIds = new Set(existingInvoices.map(inv => String(inv.order)));
      const ordersToInvoice = orders.filter(o => !invoicedOrderIds.has(String(o._id)));

      if (!ordersToInvoice.length) {
        continue; // Wszystkie zlecenia już mają faktury
      }

      // Pobierz płatności dla tych zleceń
      const paymentIds = ordersToInvoice.map(o => o.paymentId).filter(Boolean);
      const payments = await Payment.find({
        _id: { $in: paymentIds },
        status: 'succeeded'
      }).lean();

      const paymentMap = new Map(payments.map(p => [String(p._id), p]));

      // Przygotuj pozycje faktury (suma wszystkich zleceń)
      let totalGrossAmount = 0;
      const items = [];

      for (const order of ordersToInvoice) {
        const grossAmount = order.amountTotal || order.pricing?.total || 0;
        totalGrossAmount += grossAmount;

        const payment = order.paymentId ? paymentMap.get(String(order.paymentId)) : null;
        
        items.push({
          description: order.service || 'Usługa Helpfli',
          quantity: 1,
          unitPrice: grossAmount,
          totalPrice: grossAmount,
          orderId: order._id,
          paymentId: order.paymentId || null
        });
      }

      if (totalGrossAmount === 0) {
        continue; // Brak kwoty do fakturowania
      }

      // Oblicz kwoty netto i VAT
      const taxRate = 23;
      const subtotal = Math.round(totalGrossAmount / (1 + taxRate / 100));
      const taxAmount = totalGrossAmount - subtotal;

      // Dane nabywcy
      const buyerName = client.billing?.customerType === 'company'
        ? (client.billing?.companyName || client.name || client.email)
        : (client.name || client.email);

      const saleDate = end; // Data sprzedaży = ostatni dzień okresu
      const dueDate = new Date(end);
      dueDate.setDate(dueDate.getDate() + 14); // Termin płatności: 14 dni od końca okresu

      // Utwórz fakturę zbiorczą
      const invoice = await Invoice.create({
        ownerType: 'user',
        owner: client._id,
        source: 'order',
        order: null, // Brak pojedynczego zlecenia (faktura zbiorcza)
        payment: null, // Brak pojedynczej płatności
        saleDate,
        dueDate,
        buyer: {
          name: buyerName,
          email: client.email,
          nip: client.billing?.customerType === 'company' ? (client.billing?.nip || '') : '',
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
        items,
        summary: {
          subtotal,
          taxRate,
          taxAmount,
          total: totalGrossAmount,
          currency: (process.env.CURRENCY || 'pln').toUpperCase()
        },
        status: 'issued',
        metadata: {
          generatedAutomatically: true,
          customerType: client.billing?.customerType || 'individual',
          invoiceMode: 'monthly',
          periodStart: start,
          periodEnd: end,
          orderIds: ordersToInvoice.map(o => o._id),
          orderCount: ordersToInvoice.length
        }
      });

      // Wyślij powiadomienie do klienta
      try {
        await NotificationService.sendNotification(
          'client_invoice_issued',
          [client._id],
          {
            clientName: client.name || client.email,
            service: `Faktura zbiorcza za ${ordersToInvoice.length} zlecenia`,
            orderId: null,
            invoiceNumber: invoice.invoiceNumber
          }
        );
      } catch (notifyErr) {
        console.error(`[ClientMonthlyInvoices] Notification error for client ${client._id}:`, notifyErr);
      }

      generated++;
      console.log(`[ClientMonthlyInvoices] Generated monthly invoice ${invoice.invoiceNumber} for client ${client.email} (${ordersToInvoice.length} orders)`);
    } catch (error) {
      console.error(`[ClientMonthlyInvoices] Error generating invoice for client ${client._id}:`, error);
      errors.push({
        clientId: client._id,
        clientEmail: client.email,
        error: error.message
      });
    }
  }

  return { generated, errors };
}

/**
 * Generuje miesięczne faktury dla poprzedniego miesiąca (wywoływane przez cron)
 */
async function generatePreviousMonthInvoices() {
  const now = dayjs();
  const lastMonth = now.subtract(1, 'month');
  const periodStart = lastMonth.startOf('month').toDate();
  const periodEnd = lastMonth.endOf('month').toDate();

  return await generateMonthlyInvoices(periodStart, periodEnd);
}

module.exports = {
  generateMonthlyInvoices,
  generatePreviousMonthInvoices
};






