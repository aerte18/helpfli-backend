/**
 * FeedbackService
 * Zarządza feedbackiem od użytkowników dla AI agentów
 */

const AIFeedback = require('../models/AIFeedback');
const ConversationMemoryService = require('./ConversationMemoryService');

class FeedbackService {
  /**
   * Zbierz feedback dla odpowiedzi AI
   */
  static async collectFeedback({
    userId,
    sessionId,
    messageId,
    agent,
    quickFeedback, // 'positive' | 'negative'
    rating, // 1-5
    comment,
    wasHelpful,
    actionTaken,
    metadata = {}
  }) {
    try {
      const feedbackData = {
        user: userId,
        sessionId,
        messageId,
        agent: agent || 'concierge',
        description: metadata.description || comment || `Feedback for ${agent || 'concierge'} agent`, // Wymagane pole
        quickFeedback: quickFeedback || null,
        wasHelpful: wasHelpful !== undefined ? wasHelpful : null,
        actionTaken: actionTaken || null,
        actionTimestamp: actionTaken ? new Date() : null,
        feedback: {
          rating: rating || null,
          comment: comment || null
        },
        metadata,
        feedbackGivenAt: new Date()
      };

      // Spróbuj znaleźć istniejący feedback (update)
      let feedback = await AIFeedback.findOne({ user: userId, sessionId, messageId });
      
      if (feedback) {
        // Aktualizuj istniejący feedback
        Object.assign(feedback, feedbackData);
        await feedback.save();
      } else {
        // Utwórz nowy feedback
        feedback = await AIFeedback.create(feedbackData);
      }

      // Jeśli rating/feedback jest pozytywny, zaktualizuj statystyki sesji
      if (rating && rating >= 4) {
        await this.updateSessionStats(userId, sessionId, 'positive');
      } else if (quickFeedback === 'negative' || (rating && rating <= 2)) {
        await this.updateSessionStats(userId, sessionId, 'negative');
      }

      return feedback;
    } catch (error) {
      console.error('Error collecting feedback:', error);
      throw error;
    }
  }

  /**
   * Aktualizuj statystyki sesji na podstawie feedbacku
   */
  static async updateSessionStats(userId, sessionId, feedbackType) {
    try {
      // Możemy aktualizować statystyki w ConversationMemory
      // To jest uproszczona wersja - można rozbudować
      console.log(`Updating session stats for ${sessionId}: ${feedbackType}`);
    } catch (error) {
      console.error('Error updating session stats:', error);
    }
  }

  /**
   * Pobierz statystyki feedbacku dla agenta
   */
  static async getAgentStats(agent, timeRange = 30) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - timeRange);

      const stats = await AIFeedback.aggregate([
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
            positive: {
              $sum: {
                $cond: [
                  { $or: [
                    { $eq: ['$quickFeedback', 'positive'] },
                    { $gte: ['$feedback.rating', 4] }
                  ]},
                  1,
                  0
                ]
              }
            },
            negative: {
              $sum: {
                $cond: [
                  { $or: [
                    { $eq: ['$quickFeedback', 'negative'] },
                    { $lte: ['$feedback.rating', 2] }
                  ]},
                  1,
                  0
                ]
              }
            },
            averageRating: {
              $avg: '$feedback.rating'
            },
            helpfulCount: {
              $sum: {
                $cond: [{ $eq: ['$wasHelpful', true] }, 1, 0]
              }
            },
            actions: {
              $push: '$actionTaken'
            }
          }
        }
      ]);

      if (stats.length === 0) {
        return {
          total: 0,
          positive: 0,
          negative: 0,
          averageRating: 0,
          satisfactionRate: 0,
          helpfulRate: 0,
          conversionRate: 0,
          actions: {}
        };
      }

      const stat = stats[0];
      const total = stat.total || 0;
      const positive = stat.positive || 0;
      const negative = stat.negative || 0;
      const helpful = stat.helpfulCount || 0;
      
      // Oblicz conversion rate (ile zakończyło się akcją)
      const actions = stat.actions || [];
      const successfulActions = actions.filter(a => a && a !== 'none' && a !== 'other').length;
      const conversionRate = total > 0 ? (successfulActions / total) * 100 : 0;

      return {
        total,
        positive,
        negative,
        averageRating: stat.averageRating || 0,
        satisfactionRate: total > 0 ? (positive / total) * 100 : 0,
        helpfulRate: total > 0 ? (helpful / total) * 100 : 0,
        conversionRate,
        actions: this.countActions(actions)
      };
    } catch (error) {
      console.error('Error getting agent stats:', error);
      return {
        total: 0,
        positive: 0,
        negative: 0,
        averageRating: 0,
        satisfactionRate: 0,
        helpfulRate: 0,
        conversionRate: 0,
        actions: {}
      };
    }
  }

  /**
   * Pobierz statystyki dla wszystkich agentów
   */
  static async getAllAgentsStats(timeRange = 30) {
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
      
      for (const agent of agents) {
        stats[agent] = await this.getAgentStats(agent, timeRange);
      }

      // Overall stats
      const overall = await AIFeedback.aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - timeRange * 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            averageRating: { $avg: '$feedback.rating' },
            satisfactionRate: {
              $avg: {
                $cond: [
                  { $or: [
                    { $eq: ['$quickFeedback', 'positive'] },
                    { $gte: ['$feedback.rating', 4] }
                  ]},
                  1,
                  0
                ]
              }
            }
          }
        }
      ]);

      stats.overall = overall.length > 0 ? {
        total: overall[0].total || 0,
        averageRating: overall[0].averageRating || 0,
        satisfactionRate: (overall[0].satisfactionRate || 0) * 100
      } : {
        total: 0,
        averageRating: 0,
        satisfactionRate: 0
      };

      return stats;
    } catch (error) {
      console.error('Error getting all agents stats:', error);
      return {};
    }
  }

  /**
   * Pobierz feedback dla użytkownika
   */
  static async getUserFeedback(userId, limit = 10) {
    try {
      return await AIFeedback.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    } catch (error) {
      console.error('Error getting user feedback:', error);
      return [];
    }
  }

  /**
   * Pomocnicza metoda do liczenia akcji
   */
  static countActions(actions) {
    const counts = {};
    actions.forEach(action => {
      if (action && action !== 'none' && action !== 'other') {
        counts[action] = (counts[action] || 0) + 1;
      }
    });
    return counts;
  }

  /**
   * Pobierz problematyczne odpowiedzi (negatywny feedback)
   */
  static async getProblematicResponses(agent = null, limit = 20) {
    try {
      const match = {
        $or: [
          { quickFeedback: 'negative' },
          { 'feedback.rating': { $lte: 2 } },
          { wasHelpful: false }
        ]
      };

      if (agent) {
        match.agent = agent;
      }

      return await AIFeedback.find(match)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('sessionId messageId agent feedback comment metadata createdAt')
        .lean();
    } catch (error) {
      console.error('Error getting problematic responses:', error);
      return [];
    }
  }
}

module.exports = FeedbackService;

