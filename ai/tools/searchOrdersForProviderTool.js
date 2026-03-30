/**
 * Tool: searchOrdersForProvider
 * Wyszukuje zlecenia otwarte najlepiej dopasowane do providera lub z największym potencjałem zarobku.
 */

const Order = require('../../models/Order');
const User = require('../../models/User');
const { shouldFilterDemoData, getDemoUserIds } = require('../../utils/demoAccounts');
const { buildServiceSlugPrefixRegex } = require('../../utils/serviceSlugRegex');

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

  // Slugi usług providera: liść + parent_slug (jak w panelu / GET open orders)
  const providerServiceSlugs = [];
  if (provider.services && Array.isArray(provider.services)) {
    provider.services.forEach((s) => {
      if (typeof s === 'object' && s !== null) {
        if (s.slug) providerServiceSlugs.push(s.slug);
        if (s.parent_slug && s.parent_slug !== s.slug) providerServiceSlugs.push(s.parent_slug);
      } else if (s) {
        providerServiceSlugs.push(String(s));
      }
    });
  }
  // Legacy `provider.service` uwzględniaj tylko gdy konto nie ma nowej tablicy `services`.
  // Inaczej potrafi mieszać stare branże (np. IT) z aktualnym profilem.
  if ((!provider.services || provider.services.length === 0) && provider.service && typeof provider.service === 'string') {
    const s = provider.service.trim().toLowerCase();
    if (s && !providerServiceSlugs.includes(s)) providerServiceSlugs.push(s);
  }
  const uniqueSlugs = [...new Set(providerServiceSlugs.filter(Boolean))];

  const baseStatus = { status: { $in: ['open', 'collecting_offers'] } };
  const andParts = [baseStatus];
  if (shouldFilterDemoData(provider)) {
    const demoIds = await getDemoUserIds();
    if (demoIds.length) {
      andParts.push({ client: { $nin: demoIds } });
    }
  }
  if (sortBy === 'best_match' && uniqueSlugs.length > 0) {
    const orBranches = uniqueSlugs
      .map((slug) => buildServiceSlugPrefixRegex(slug))
      .filter(Boolean)
      .map((re) => ({ service: { $regex: re } }));
    if (orBranches.length > 0) {
      andParts.push({ $or: orBranches });
    }
  }
  const query = andParts.length === 1 ? andParts[0] : { $and: andParts };

  const providerCity = (provider.location || '').trim();

  const normalizeSlug = (s) => String(s || '').toLowerCase().replace(/_/g, '-').trim();
  const matchSvc = (orderSvc) => {
    const os = normalizeSlug(orderSvc);
    if (!os) return false;
    return uniqueSlugs.some((s) => {
      const ps = normalizeSlug(s);
      if (!ps) return false;
      return (
        os === ps ||
        os.startsWith(`${ps}-`) ||
        ps.startsWith(`${os}-`)
      );
    });
  };

  const cityMatch = (order) => {
    if (!providerCity) return false;
    const cityText = String(order.city || order.location?.address || order.location || '').toLowerCase();
    return cityText.includes(providerCity.toLowerCase());
  };

  const scoreOrder = (order) => {
    let score = 0;
    if (uniqueSlugs.length && matchSvc(order.service)) score += 6; // najważniejsze: zgodność usługi
    if (cityMatch(order)) score += 2; // lokalizacja
    const budget = budgetValue(order);
    if (budget >= 300) score += 1; // lekka preferencja sensownego budżetu
    return score;
  };

  let orders = await Order.find(query)
    .select('_id service description city location budget budgetRange urgency createdAt')
    .sort({ createdAt: -1 })
    .limit(limit * 2)
    .lean();

  // Gdy zapytanie z $or nie zwróci nic (np. starszy format slugów) — otwarte zlecenia + sort po dopasowaniu
  if (sortBy === 'best_match' && orders.length === 0 && uniqueSlugs.length > 0) {
    const fallbackParts = [baseStatus];
    if (shouldFilterDemoData(provider)) {
      const demoIds = await getDemoUserIds();
      if (demoIds.length) {
        fallbackParts.push({ client: { $nin: demoIds } });
      }
    }
    const fallbackQuery = fallbackParts.length === 1 ? fallbackParts[0] : { $and: fallbackParts };
    orders = await Order.find(fallbackQuery)
      .select('_id service description city location budget budgetRange urgency createdAt')
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .lean();
  }

  const budgetValue = (o) => {
    if (o.budgetRange && (o.budgetRange.max != null || o.budgetRange.min != null)) {
      return o.budgetRange.max != null ? o.budgetRange.max : o.budgetRange.min;
    }
    return o.budget != null ? o.budget : 0;
  };

  if (sortBy === 'earning_potential') {
    orders = orders.sort((a, b) => budgetValue(b) - budgetValue(a));
  } else {
    // Jeśli mamy dopasowania usługowe, nie pokazuj "losowych" branż.
    if (uniqueSlugs.length > 0) {
      const matched = orders.filter((o) => matchSvc(o.service));
      // Gdy zapytanie regex/fallback zwróciło zlecenia spoza profilu (np. starszy format w DB),
      // matched może być puste — wtedy NIE zostawiaj pełnej listy z fallbacku (obce branże).
      orders = matched.length > 0 ? matched : [];
    }

    orders = orders.sort((a, b) => {
      const scoreA = scoreOrder(a);
      const scoreB = scoreOrder(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const budgetDelta = budgetValue(b) - budgetValue(a);
      if (budgetDelta !== 0) return budgetDelta;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
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
