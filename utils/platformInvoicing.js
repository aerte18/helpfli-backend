/** Czy Helpfli może wystawiać faktury za subskrypcje / opłaty platformy */
function isPlatformInvoicingEnabled() {
  const flag = process.env.PLATFORM_INVOICING_ENABLED;
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  const nip = String(process.env.INVOICE_SELLER_NIP || '').trim();
  return nip.length >= 10;
}

module.exports = { isPlatformInvoicingEnabled };
