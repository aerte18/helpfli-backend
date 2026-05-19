/**
 * AIAnalyticsService
 * Tracking i analiza użycia AI agentów
 */

const AIAnalytics = require('../models/AIAnalytics');
const crypto = require('crypto');

class AIAnalyticsService {
  /**
   * Generuj unikalny requestId
   */
  static generateRequestId() {
    return `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Zarejestruj request/response
   */
  static async trackRequest({
    requestId,
    userId,
    sessionId,
    agent,
    agentChain = [],
    endpoint,
    requestSize = 0,
    messageCount = 0,
    responseTime,
    success = true,
    error = null,
    errorType = null,
    llmProvider = 'claude',
    llmModel = null,
    tokensInput = 0,
    tokensOutput = 0,
    costEstimate = 0,
    quality = {},
    metadata = {}
  }) {
    try {
      let ti = tokensInput || 0;
      let to = tokensOutput || 0;
      if (ti === 0 && to === 0) {
        ti = Math.max(300, (messageCount || 1) * 280);
        to = 450;
      }
      const tokensTotal = ti + to;

      let cost = costEstimate || 0;
      if (cost === 0 && tokensTotal > 0) {
        cost = this.estimateCost(llmProvider, llmModel, ti, to);
      }
      
      const analytics = await AIAnalytics.create({
        requestId: requestId || this.generateRequestId(),
        userId,
        sessionId,
        agent,
        agentChain,
        endpoint,
        requestSize,
        messageCount,
        responseTime,
        success,
        error,
        errorType,
        llmProvider,
        llmModel,
        tokensInput: ti,
        tokensOutput: to,
        tokensTotal,
        costEstimate: cost,
        currency: 'PLN',
        quality,
        metadata,
        date: new Date()
      });
      
      return analytics;
    } catch (error) {
      console.error('Error tracking request:', error);
      // Nie przerywamy procesu - analytics to nice-to-have
      return null;
    }
  }

  /**
   * Szacuj koszt na podstawie providera i tokenów
   */
  static estimateCost(provider, model, inputTokens, outputTokens) {
    // Ceny w groszach (PLN * 100) per 1K tokens
    const pricing = {
      claude: {
        'claude-3-5-sonnet-20241022': { input: 15, output: 75 }, // $3/$15 per 1M
        'claude-3-5-haiku-20241022': { input: 2, output: 10 }, // $0.25/$1.25 per 1M
        'claude-3-opus-20240229': { input: 150, output: 750 }, // $15/$75 per 1M
        default: { input: 15, output: 75 }
      },
      ollama: {
        default: { input: 0, output: 0 } // Lokalne, bez kosztów
      },
      openai: {
        'gpt-4': { input: 300, output: 600 },
        'gpt-3.5-turbo': { input: 5, output: 15 },
        default: { input: 5, output: 15 }
      },
      gemini: {
        'gemini-2.0-flash': { input: 1, output: 4 },
        'gemini-2.5-flash': { input: 1, output: 4 },
        'gemini-1.5-flash': { input: 1, output: 4 },
        default: { input: 1, output: 4 }
      }
    };

    const providerPricing = pricing[provider] || pricing.claude;
    const modelPricing = providerPricing[model] || providerPricing.default;
    
    // Konwersja: 1K tokens = modelPricing cents
    // Przyjmujemy kurs ~4 PLN per USD (przybliżony)
    const inputCost = (inputTokens / 1000) * (modelPricing.input / 100) * 4; // grosze
    const outputCost = (outputTokens / 1000) * (modelPricing.output / 100) * 4; // grosze
    
    return Math.round(inputCost + outputCost);
  }

  /**
   * Pobierz statystyki dla agenta
   */
  static async getAgentStats(agent, timeRange = 7) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - timeRange);

      const stats = await AIAnalytics.aggregate([
        {
          $match: {
            agent: agent,
            createdAt: { $gte: since }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            successful: {
              $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] }
            },
            failed: {
              $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] }
            },
            avgResponseTime: { $avg: '$responseTime' },
            avgTokensTotal: { $avg: '$tokensTotal' },
            totalCost: { $sum: '$costEstimate' },
            totalTokens: { $sum: '$tokensTotal' }
          }
        }
      ]);

      if (stats.length === 0) {
        return {
          total: 0,
          successful: 0,
          failed: 0,
          successRate: 0,
          avgResponseTime: 0,
          avgTokensTotal: 0,
          totalCost: 0,
          totalTokens: 0
        };
      }

      const stat = stats[0];
      const total = stat.total || 0;

      return {
        total,
        successful: stat.successful || 0,
        failed: stat.failed || 0,
        successRate: total > 0 ? ((stat.successful || 0) / total) * 100 : 0,
        avgResponseTime: Math.round(stat.avgResponseTime || 0),
        avgTokensTotal: Math.round(stat.avgTokensTotal || 0),
        totalCost: stat.totalCost || 0, // w groszach
        totalTokens: stat.totalTokens || 0
      };
    } catch (error) {
      console.error('Error getting agent stats:', error);
      return {
        total: 0,
        successful: 0,
        failed: 0,
        successRate: 0,
        avgResponseTime: 0,
        avgTokensTotal: 0,
        totalCost: 0,
        totalTokens: 0
      };
    }
  }

  /**
   * Pobierz statystyki dla wszystkich agentów
   */
  static async getAllAgentsStats(timeRange = 7) {
    try {
      const agents = [
        'concierge',
        'diagnostic',
        'pricing',
        'diy',
        'matching',
        'order_draft',
        'post_order',
        'provider_orchestrator',
        'offer',
        'pricing_provider'
      ];

      const stats = {};
      let totalCost = 0;
      let totalRequests = 0;
      
      for (const agent of agents) {
        const agentStats = await this.getAgentStats(agent, timeRange);
        stats[agent] = agentStats;
        totalCost += agentStats.totalCost;
        totalRequests += agentStats.total;
      }

      // Overall stats
      const since = new Date();
      since.setDate(since.getDate() - timeRange);
      
      const overall = await AIAnalytics.aggregate([
        {
          $match: {
            createdAt: { $gte: since }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            successful: { $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] } },
            avgResponseTime: { $avg: '$responseTime' },
            totalCost: { $sum: '$costEstimate' },
            totalTokens: { $sum: '$tokensTotal' }
          }
        }
      ]);

      stats.overall = overall.length > 0 ? {
        total: overall[0].total || 0,
        successful: overall[0].successful || 0,
        successRate: overall[0].total > 0 
          ? ((overall[0].successful || 0) / overall[0].total) * 100 
          : 0,
        avgResponseTime: Math.round(overall[0].avgResponseTime || 0),
        totalCost: overall[0].totalCost || 0,
        totalTokens: overall[0].totalTokens || 0
      } : {
        total: 0,
        successful: 0,
        successRate: 0,
        avgResponseTime: 0,
        totalCost: 0,
        totalTokens: 0
      };

      return stats;
    } catch (error) {
      console.error('Error getting all agents stats:', error);
      return {};
    }
  }

  /**
   * Pobierz błędy (dla debugowania)
   */
  static async getErrors(timeRange = 7, limit = 50) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - timeRange);

      return await AIAnalytics.find({
        success: false,
        createdAt: { $gte: since }
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('requestId agent endpoint error errorType responseTime createdAt')
        .lean();
    } catch (error) {
      console.error('Error getting errors:', error);
      return [];
    }
  }

  /**
   * Pobierz statystyki kosztów
   */
  static groszeToPln(grosze) {
    return Number((grosze / 100).toFixed(4));
  }

  /**
   * Statystyki hybrydowego routingu LLM (Gemini vs Claude)
   */
  static async getAiRoutingStats(timeRange = 30) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - timeRange);

      const match = { createdAt: { $gte: since } };

      const [byProvider, byTier, escalations, dailyByProvider, routingMode, totalAgg] = await Promise.all([
        AIAnalytics.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$llmProvider',
              requests: { $sum: 1 },
              successful: { $sum: { $cond: ['$success', 1, 0] } },
              failed: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
              costGrosze: { $sum: '$costEstimate' },
              tokensTotal: { $sum: '$tokensTotal' },
              avgResponseTimeMs: { $avg: '$responseTime' }
            }
          },
          { $sort: { requests: -1 } }
        ]),
        AIAnalytics.aggregate([
          { $match: { ...match, 'metadata.llmTier': { $in: ['cheap', 'smart'] } } },
          {
            $group: {
              _id: '$metadata.llmTier',
              requests: { $sum: 1 },
              costGrosze: { $sum: '$costEstimate' }
            }
          }
        ]),
        AIAnalytics.countDocuments({ ...match, 'metadata.llmEscalated': true }),
        AIAnalytics.aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                provider: '$llmProvider'
              },
              requests: { $sum: 1 },
              costGrosze: { $sum: '$costEstimate' }
            }
          },
          { $sort: { '_id.date': 1 } }
        ]),
        AIAnalytics.aggregate([
          { $match: { ...match, 'metadata.llmRoutingMode': { $exists: true, $ne: null } } },
          { $group: { _id: '$metadata.llmRoutingMode', count: { $sum: 1 } } }
        ]),
        AIAnalytics.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              requests: { $sum: 1 },
              costGrosze: { $sum: '$costEstimate' },
              tokensTotal: { $sum: '$tokensTotal' }
            }
          }
        ])
      ]);

      const totalRequests = totalAgg[0]?.requests || 0;
      const totalCostGrosze = totalAgg[0]?.costGrosze || 0;

      const providers = {};
      let geminiRequests = 0;
      let claudeRequests = 0;
      let geminiCostGrosze = 0;
      let claudeCostGrosze = 0;

      for (const row of byProvider) {
        const key = row._id || 'unknown';
        const sharePct = totalRequests > 0 ? Number(((row.requests / totalRequests) * 100).toFixed(1)) : 0;
        providers[key] = {
          requests: row.requests,
          successful: row.successful,
          failed: row.failed,
          successRate: row.requests > 0 ? Number(((row.successful / row.requests) * 100).toFixed(1)) : 0,
          sharePct,
          costGrosze: row.costGrosze,
          costPln: this.groszeToPln(row.costGrosze),
          tokensTotal: row.tokensTotal,
          avgResponseTimeMs: Math.round(row.avgResponseTimeMs || 0)
        };
        if (key === 'gemini') {
          geminiRequests = row.requests;
          geminiCostGrosze = row.costGrosze;
        }
        if (key === 'claude') {
          claudeRequests = row.requests;
          claudeCostGrosze = row.costGrosze;
        }
      }

      const tiers = {};
      for (const row of byTier) {
        tiers[row._id] = {
          requests: row.requests,
          costGrosze: row.costGrosze,
          costPln: this.groszeToPln(row.costGrosze)
        };
      }

      const daily = dailyByProvider.map((row) => ({
        date: row._id.date,
        provider: row._id.provider || 'unknown',
        requests: row.requests,
        costPln: this.groszeToPln(row.costGrosze)
      }));

      const hybridSharePct =
        geminiRequests + claudeRequests > 0
          ? Number(((geminiRequests / (geminiRequests + claudeRequests)) * 100).toFixed(1))
          : null;

      const savingsNote =
        geminiRequests > 0 && claudeCostGrosze > 0
          ? (() => {
              const avgClaudePerReq = claudeCostGrosze / Math.max(claudeRequests, 1);
              const counterfactualGrosze = Math.round(geminiRequests * avgClaudePerReq);
              const savedGrosze = Math.max(0, counterfactualGrosze - geminiCostGrosze);
              return {
                estimatedSavedPln: this.groszeToPln(savedGrosze),
                method: 'gemini_requests * avg_claude_cost_per_request - gemini_actual_cost'
              };
            })()
          : null;

      return {
        timeRangeDays: timeRange,
        since: since.toISOString(),
        currency: 'PLN',
        summary: {
          totalRequests,
          totalCostPln: this.groszeToPln(totalCostGrosze),
          totalTokens: totalAgg[0]?.tokensTotal || 0,
          escalationsToClaude: escalations,
          hybridGeminiSharePct: hybridSharePct,
          estimatedSavings: savingsNote
        },
        providers,
        tiers,
        routingModes: routingMode.reduce((acc, r) => {
          acc[r._id] = r.count;
          return acc;
        }, {}),
        daily,
        config: {
          routerMode: process.env.AI_ROUTER_MODE || process.env.AI_MODE || 'auto',
          cheapModel: process.env.AI_CHEAP_MODEL || 'gemini-2.0-flash',
          smartModel: process.env.AI_SMART_MODEL || process.env.CLAUDE_DEFAULT || null
        }
      };
    } catch (error) {
      console.error('Error getting AI routing stats:', error);
      throw error;
    }
  }

  static async getCostStats(timeRange = 30) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - timeRange);

      const stats = await AIAnalytics.aggregate([
        {
          $match: {
            createdAt: { $gte: since }
          }
        },
        {
          $group: {
            _id: {
              agent: '$agent',
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
            },
            cost: { $sum: '$costEstimate' },
            requests: { $sum: 1 },
            tokens: { $sum: '$tokensTotal' }
          }
        },
        {
          $sort: { '_id.date': -1, '_id.agent': 1 }
        }
      ]);

      return stats;
    } catch (error) {
      console.error('Error getting cost stats:', error);
      return [];
    }
  }
}

module.exports = AIAnalyticsService;

