?// AI-powered advanced pricing suggestions
const claudeService = require('./claude');
const { computePricingBands } = require('../utils/pricing');
const Order = require('../models/Order');
const Offer = require('../models/Offer');
const User = require('../models/User');

class AIPricingService {
  /**
   * Generuje zaawansowane sugestie cenowe z AI analizą
   * @param {Object} params - { orderId, providerId, proposedAmount, orderDescription }
   */
  async generateAdvancedPricingAdvice({ orderId, providerId, proposedAmount, orderDescription = '' }) {
    try {
      // 1. Pobierz dane zlecenia
      const order = await Order.findById(orderId).lean();
      if (!order) {
        throw new Error('Zlecenie nie znalezione');
      }

      // 2. Pobierz dane wykonawcy
      const provider = await User.findById(providerId).lean();
      if (!provider) {
        throw new Error('Wykonawca nie znaleziony');
      }

      // 3. Oblicz podstawowe widełki cenowe
      const bands = await computePricingBands({
        service: order.service || 'inne',
        city: order.location?.city || null,
        lat: order.location?.coords?.coordinates?.[1] ?? null,
        lng: order.location?.coords?.coordinates?.[0] ?? null,
        urgency: order.urgency || 'normal'
      });

      // 4. Pobierz historię podobnych zleceń i ofert
      const similarOrders = await this.getSimilarOrders(order);
      const providerHistory = await this.getProviderHistory(providerId, order.service);
      const competitorOffers = await this.getCompetitorOffers(orderId);

      // 5. Przygotuj kontekst dla AI
      const context = this.buildPricingContext({
        order,
        provider,
        bands,
        similarOrders,
        providerHistory,
        competitorOffers,
        proposedAmount
      });

      // 6. Wywołaj Claude AI dla zaawansowanej analizy
      let aiAnalysis = null;
      try {
        const prompt = this.buildPricingPrompt(context, orderDescription);
        const rawResponse = await claudeService.analyzeWithClaude({
          description: prompt,
          imageUrls: [],
          lang: 'pl'
        });
        
        // Claude zwraca już sparsowany JSON, ale sprawdźmy czy mamy pricing advice
        if (rawResponse && typeof rawResponse === 'object') {
          // Spróbuj wyciągnąć JSON z odpowiedzi jeśli jest w tekście
          const text = JSON.stringify(rawResponse);
          const jsonMatch = text.match(/\{[\s\S]*"recommendation"[\s\S]*\}/);
          if (jsonMatch) {
            aiAnalysis = JSON.parse(jsonMatch[0]);
          } else {
            // Jeśli nie ma JSON, użyj surowej odpowiedzi
            aiAnalysis = rawResponse;
          }
        }
      } catch (error) {
        console.warn('Claude AI pricing analysis failed, using fallback:', error.message);
      }

      // 7. Połącz wyniki AI z danymi statystycznymi
      return this.combineResults({
        bands,
        providerHistory,
        competitorOffers,
        proposedAmount,
        aiAnalysis,
        order
      });
    } catch (error) {
      console.error('Advanced pricing advice error:', error);
      // Fallback do podstawowych sugestii
      return this.getFallbackAdvice(proposedAmount, bands);
    }
  }

  /**
   * Pobiera podobne zlecenia
   */
  async getSimilarOrders(order) {
    const match = {
      service: order.service,
      status: { $in: ['completed', 'closed', 'paid'] },
      createdAt: { $gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) }
    };

    if (order.location?.city) {
      match['location.city'] = { $regex: order.location.city, $options: 'i' };
    }

    const orders = await Order.find(match)
      .select('amountTotal pricing urgency createdAt')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return orders.map(o => ({
      amount: o.amountTotal || o.pricing?.total || 0,
      urgency: o.urgency,
      date: o.createdAt
    }));
  }

  /**
   * Pobiera historię wykonawcy
   */
  async getProviderHistory(providerId, serviceCode) {
    const offers = await Offer.find({
      providerId,
      status: { $in: ['accepted', 'completed'] }
    })
      .populate('orderId', 'service')
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const relevantOffers = offers.filter(o => {
      const orderService = o.orderId?.service;
      return !serviceCode || orderService === serviceCode || 
             String(orderService).includes(serviceCode);
    });

    if (relevantOffers.length === 0) return null;

    const amounts = relevantOffers.map(o => o.amount).filter(Boolean);
    const acceptedCount = relevantOffers.filter(o => o.status === 'accepted').length;
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;

    return {
      totalOffers: relevantOffers.length,
      acceptedCount,
      acceptanceRate: acceptedCount / relevantOffers.length,
      avgAmount: Math.round(avgAmount),
      minAmount: Math.min(...amounts),
      maxAmount: Math.max(...amounts)
    };
  }

  /**
   * Pobiera oferty konkurentów
   */
  async getCompetitorOffers(orderId) {
    const offers = await Offer.find({
      orderId,
      status: { $ne: 'rejected' }
    })
      .select('amount status createdAt')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    if (offers.length === 0) return null;

    const amounts = offers.map(o => o.amount).filter(Boolean);
    return {
      count: offers.length,
      min: Math.min(...amounts),
      max: Math.max(...amounts),
      avg: Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length),
      median: this.percentile(amounts, 0.5)
    };
  }

  /**
   * Buduje kontekst dla AI
   */
  buildPricingContext({ order, provider, bands, similarOrders, providerHistory, competitorOffers, proposedAmount }) {
    return {
      order: {
        service: order.service,
        description: order.description || order.title || '',
        urgency: order.urgency,
        location: order.location?.city || 'nieznana',
        createdAt: order.createdAt
      },
      provider: {
        rating: provider.rating || 0,
        ratingCount: provider.ratingCount || 0,
        level: provider.providerLevel || 'standard',
        tier: provider.providerTier || 'basic',
        experience: providerHistory
      },
      market: {
        bands: bands.stats.adjusted,
        recommended: bands.recommended,
        sampleSize: bands.stats.sample
      },
      competition: competitorOffers,
      similarOrders: similarOrders.slice(0, 10),
      proposedAmount
    };
  }

  /**
   * Buduje prompt dla Claude AI
   */
  buildPricingPrompt(context, orderDescription) {
    const { order, provider, market, competition, similarOrders, proposedAmount } = context;

    return `Jesteś ekspertem od wyceny usług w serwisie Helpfli. Przeanalizuj poniższe dane i udziel szczegółowej porady cenowej.

Zlecenie:
- Usługa: ${order.service}
- Opis: ${orderDescription || order.description || 'Brak opisu'}
- Pilność: ${order.urgency}
- Lokalizacja: ${order.location}

Wykonawca:
- Ocena: ${provider.rating}/5 (${provider.ratingCount} opinii)
- Poziom: ${provider.level}
- Pakiet: ${provider.tier}
${provider.experience ? `- Historia: ${provider.experience.totalOffers} ofert, ${Math.round(provider.experience.acceptanceRate * 100)}% akceptacji, średnia cena: ${provider.experience.avgAmount} zł` : ''}

Rynek:
- Zalecane widełki: ${market.recommended.min}-${market.recommended.max} zł (średnia: ${market.recommended.midpoint} zł)
- Próbka danych: ${market.sampleSize} podobnych zleceń
- Mediana rynkowa: ${market.bands.med} zł

Konkurencja:
${competition ? `- Liczba ofert: ${competition.count}
- Zakres: ${competition.min}-${competition.max} zł
- Średnia: ${competition.avg} zł` : '- Brak innych ofert'}

Proponowana cena: ${proposedAmount} zł

Przeanalizuj i odpowiedz w formacie JSON:
{
  "recommendation": "optimal|low|high|below_min|above_max",
  "confidence": 0.0-1.0,
  "suggestedAmount": liczba,
  "reasoning": "szczegółowe uzasadnienie w 2-3 zdaniach",
  "strengths": ["mocna strona 1", "mocna strona 2"],
  "risks": ["ryzyko 1", "ryzyko 2"],
  "tips": ["wskazówka 1", "wskazówka 2"]
}`;
  }

  /**
   * Łączy wyniki AI z danymi statystycznymi
   */
  combineResults({ bands, providerHistory, competitorOffers, proposedAmount, aiAnalysis, order }) {
    const adj = bands.stats.adjusted;
    const position = this.calculatePosition(proposedAmount, adj);

    // Podstawowe sugestie (fallback)
    const baseAdvice = {
      position,
      suggestedMin: adj.min,
      suggestedMed: adj.med,
      suggestedMax: adj.max,
      message: this.getBasicMessage(position),
      confidence: 0.5
    };

    // Jeśli mamy analizę AI, użyj jej
    if (aiAnalysis) {
      try {
        // aiAnalysis powinien już być obiektem
        const aiResult = aiAnalysis;

        return {
          ...baseAdvice,
          position: aiResult.recommendation || position,
          suggestedAmount: aiResult.suggestedAmount || adj.med,
          reasoning: aiResult.reasoning || baseAdvice.message,
          strengths: aiResult.strengths || [],
          risks: aiResult.risks || [],
          tips: aiResult.tips || [],
          confidence: aiResult.confidence || 0.7,
          aiEnhanced: true,
          providerHistory,
          competitorOffers,
          marketData: {
            sampleSize: bands.stats.sample,
            bands: adj,
            recommended: bands.recommended
          }
        };
      } catch (error) {
        console.warn('Failed to use AI analysis:', error);
      }
    }

    // Fallback bez AI
    return {
      ...baseAdvice,
      providerHistory,
      competitorOffers,
      marketData: {
        sampleSize: bands.stats.sample,
        bands: adj,
        recommended: bands.recommended
      },
      aiEnhanced: false
    };
  }

  /**
   * Oblicza pozycję ceny względem widełek
   */
  calculatePosition(amount, bands) {
    if (amount < bands.min) return 'below_min';
    if (amount >= bands.min && amount < (bands.p25 || bands.med * 0.85)) return 'low';
    if (amount >= (bands.p25 || bands.med * 0.9) && amount <= (bands.p75 || bands.med * 1.1)) return 'fair';
    if (Math.abs(amount - bands.med) <= bands.med * 0.05) return 'optimal';
    if (amount > (bands.p75 || bands.med * 1.15) && amount <= bands.max) return 'high';
    if (amount > bands.max) return 'above_max';
    return 'fair';
  }

  /**
   * Podstawowa wiadomość na podstawie pozycji
   */
  getBasicMessage(position) {
    const messages = {
      below_min: 'Twoja oferta jest znacznie poniżej rynkowej średniej. Rozważ podniesienie ceny, aby zwiększyć szansę akceptacji.',
      low: 'Twoja oferta jest w dolnej części widełek. Możesz rozważyć lekkie podniesienie ceny.',
      fair: 'Twoja oferta mieści się w typowych widełkach – jest konkurencyjna cenowo.',
      optimal: 'Twoja oferta jest blisko optymalnej ceny rynkowej. Doskonały wybór!',
      high: 'Twoja oferta jest w górnej części widełek. Dodaj uzasadnienie w opisie.',
      above_max: 'Twoja oferta jest powyżej typowych widełek. Rozważ obniżenie ceny lub dodaj szczegółowe uzasadnienie.'
    };
    return messages[position] || messages.fair;
  }

  /**
   * Fallback advice
   */
  getFallbackAdvice(proposedAmount, bands) {
    const adj = bands.stats.adjusted;
    const position = this.calculatePosition(proposedAmount, adj);
    
    return {
      position,
      suggestedMin: adj.min,
      suggestedMed: adj.med,
      suggestedMax: adj.max,
      message: this.getBasicMessage(position),
      confidence: 0.5,
      aiEnhanced: false
    };
  }

  /**
   * Percentile helper
   */
  percentile(arr, p) {
    if (!arr?.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const h = idx - lo;
    return Math.round(sorted[lo] * (1 - h) + sorted[hi] * h);
  }
}

module.exports = new AIPricingService();

