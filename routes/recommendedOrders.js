/**
 * GET /api/orders/recommended-for-provider
 * Zwraca zlecenia polecane dla zalogowanego providera z krótkim uzasadnieniem AI („dlaczego to zlecenie”).
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const searchOrdersForProviderTool = require('../ai/tools/searchOrdersForProviderTool');
const Anthropic = require('@anthropic-ai/sdk');

const MAX_ORDERS = 6;
const BASE_URL = process.env.FRONTEND_URL || process.env.APP_URL || '';

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.length < 20) return null;
  return new Anthropic({ apiKey: key });
}

/**
 * Generuje jedno zdanie uzasadnienia (po polsku) dla każdego zlecenia – batch w jednym wywołaniu LLM.
 */
async function generateReasons(orders, providerServices = [], providerCity = '') {
  const client = getClient();
  if (!client || orders.length === 0) {
    return orders.map((o) => ({ ...o, reason: 'Pasuje do Twoich usług i lokalizacji.' }));
  }

  const servicesText = providerServices.length ? providerServices.slice(0, 5).join(', ') : 'różne usługi';
  const locationText = providerCity ? ` Lokalizacja wykonawcy: ${providerCity}.` : '';

  const list = orders.map((o, i) => {
    const service = typeof o.service === 'object' ? o.service?.name_pl || o.service?.code : o.service;
    return `${i + 1}. Usługa: ${service}, miasto: ${o.city || 'nie podano'}, budżet: ${o.budgetMin ?? '?'}-${o.budgetMax ?? '?'} zł.`;
  }).join('\n');

  const system = `Jesteś asystentem platformy zleceń. Dla każdego zlecenia napisz jedno krótkie zdanie po polsku (max 15 słów), dlaczego polecamy je temu wykonawcy. Uwzględnij: dopasowanie usługi, lokalizację, budżet. Pisz zwięźle, np. "Twoja usługa i miasto idealnie pasują, budżet w typowym zakresie." Odpowiedz wyłącznie w formacie JSON: { "reasons": ["zdanie1", "zdanie2", ...] } – tyle elementów, ile zleceń.`;
  const user = `Wykonawca oferuje: ${servicesText}.${locationText}\n\nZlecenia:\n${list}`;

  try {
    const response = await client.messages.create({
      model: process.env.CLAUDE_DEFAULT || 'claude-3-5-haiku-20241022',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = response.content?.[0]?.text || '{}';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    const json = start >= 0 && end > start ? JSON.parse(text.slice(start, end)) : {};
    const reasons = Array.isArray(json.reasons) ? json.reasons : [];
    return orders.map((o, i) => ({
      ...o,
      reason: reasons[i] || 'Pasuje do Twoich usług i lokalizacji.',
    }));
  } catch (err) {
    console.warn('Recommended orders: LLM reasons failed', err.message);
    return orders.map((o) => ({ ...o, reason: 'Pasuje do Twoich usług i lokalizacji.' }));
  }
}

router.get('/recommended-for-provider', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user || (user.role !== 'provider' && user.role !== 'company_owner')) {
      return res.status(403).json({ message: 'Dostęp tylko dla wykonawców.' });
    }

    const userId = user._id || user.id;
    const context = { userId };

    const result = await searchOrdersForProviderTool({ sortBy: 'best_match', limit: MAX_ORDERS }, context);
    const rawOrders = result?.orders || [];
    if (rawOrders.length === 0) {
      return res.json({ orders: [], summary: result?.summary || 'Brak dopasowanych zleceń.' });
    }

    const providerServices = [];
    if (user.services && Array.isArray(user.services)) {
      user.services.forEach((s) => {
        const name = typeof s === 'object' && s !== null ? (s.name_pl || s.slug || s.parent_slug) : String(s);
        if (name) providerServices.push(name);
      });
    }
    const providerCity = (user.location && typeof user.location === 'string') ? user.location : (user.location?.city || user.city || '');

    const ordersWithReasons = await generateReasons(
      rawOrders.map((o) => ({
        id: o.id,
        service: o.service,
        city: o.city,
        budgetMin: o.budgetMin,
        budgetMax: o.budgetMax,
        urgency: o.urgency,
        description: o.description,
        link: o.link || (BASE_URL ? `${BASE_URL}/orders/${o.id}` : `/orders/${o.id}`),
      })),
      providerServices,
      providerCity
    );

    res.json({
      orders: ordersWithReasons,
      summary: result.summary || `Znaleziono ${ordersWithReasons.length} zleceń dla Ciebie.`,
    });
  } catch (err) {
    console.error('Recommended orders error:', err);
    res.status(500).json({ message: 'Błąd pobierania polecanych zleceń.', error: err.message });
  }
});

module.exports = router;
