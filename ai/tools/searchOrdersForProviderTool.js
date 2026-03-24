/**
 * Tool: searchOrdersForProvider
 * Wyszukuje zlecenia otwarte najlepiej dopasowane do providera lub z największym potencjałem zarobku.
 */

const Order = require('../../models/Order');
const User = require('../../models/User');

async function searchOrdersForProviderTool(params, context) {
  const userId = context.userId;
  if (!userId) {
    throw new Error('Wymagane zalogowanie (tylko dla wykonawców).');
  }

  const provider = await User.findById(userId).populate('services').lean();
  if (!provider || (provider.role !== 'provider' && provider.role !== 'company_owner')) {
    throw new Error('Dostęp tylko dla wykonawców.');
  }

  const sortBy = params.sortBy === 'earning_potential' ? 'earning_potential' : 'best_match';
  const limit = Math.min(parseInt(params.limit, 10) || 15, 30);

  // Slugi usług providera (z modelu Service)
  const providerServiceSlugs = [];
  if (provider.services && Array.isArray(provider.services)) {
    provider.services.forEach((s) => {
      const slug = typeof s === 'object' && s !== null ? s.slug : (s && String(s));
      if (slug) providerServiceSlugs.push(slug);
    });
  }
  if (provider.service && typeof provider.service === 'string') {
    const s = provider.service.trim().toLowerCase();
    if (s && !providerServiceSlugs.includes(s)) providerServiceSlugs.push(s);
  }

  const query = { status: { $in: ['open', 'collecting_offers'] } };

  if (sortBy === 'best_match' && providerServiceSlugs.length > 0) {
    const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = providerServiceSlugs.map((slug) => ({ service: new RegExp(`^${escapeRegex(slug)}$`, 'i') }));
  }

  const providerCity = (provider.location || '').trim();

  let orders = await Order.find(query)
    .select('_id service description city location budget budgetRange urgency createdAt')
    .sort({ createdAt: -1 })
    .limit(limit * 2)
    .lean();

  const budgetValue = (o) => {
    if (o.budgetRange && (o.budgetRange.max != null || o.budgetRange.min != null)) {
      return o.budgetRange.max != null ? o.budgetRange.max : o.budgetRange.min;
    }
    return o.budget != null ? o.budget : 0;
  };

  if (sortBy === 'earning_potential') {
    orders = orders.sort((a, b) => budgetValue(b) - budgetValue(a));
  } else {
    orders = orders.sort((a, b) => {
      const scoreA = (providerServiceSlugs.length && providerServiceSlugs.some(s => String(a.service).toLowerCase() === s.toLowerCase()) ? 2 : 0) +
        (providerCity && (a.city || a.location?.address || a.location) && String(a.city || a.location?.address || a.location).toLowerCase().includes(providerCity.toLowerCase()) ? 1 : 0);
      const scoreB = (providerServiceSlugs.length && providerServiceSlugs.some(s => String(b.service).toLowerCase() === s.toLowerCase()) ? 2 : 0) +
        (providerCity && (b.city || b.location?.address || b.location) && String(b.city || b.location?.address || b.location).toLowerCase().includes(providerCity.toLowerCase()) ? 1 : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return budgetValue(b) - budgetValue(a);
    });
  }

  orders = orders.slice(0, limit);

  const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || '';
  const items = orders.map((o) => {
    const city = o.city || o.location?.address || (typeof o.location === 'string' ? o.location : '') || '';
    const min = o.budgetRange?.min ?? o.budget;
    const max = o.budgetRange?.max ?? o.budget;
    return {
      id: String(o._id),
      service: typeof o.service === 'object' ? o.service?.name_pl || o.service?.code : o.service,
      description: (o.description || '').substring(0, 100) + ((o.description && o.description.length > 100) ? '…' : ''),
      city: city.substring(0, 80),
      budgetMin: min != null ? min : null,
      budgetMax: max != null ? max : null,
      urgency: o.urgency || null,
      link: baseUrl ? `${baseUrl}/orders/${o._id}` : `/orders/${o._id}`,
    };
  });

  const summary = sortBy === 'earning_potential'
    ? `Znaleziono ${items.length} zleceń posortowanych według potencjału zarobku (najwyższy budżet pierwszy).`
    : `Znaleziono ${items.length} zleceń najlepiej dopasowanych do Twoich usług${providerCity ? ` i lokalizacji (${providerCity})` : ''}.`;

  return {
    count: items.length,
    orders: items,
    sortBy,
    summary,
  };
}

module.exports = searchOrdersForProviderTool;
