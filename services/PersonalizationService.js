/**
 * PersonalizationService
 * Zaawansowana personalizacja odpowiedzi AI na podstawie profilu użytkownika
 */

const ConversationMemoryService = require('./ConversationMemoryService');
const Order = require('../models/Order');
const User = require('../models/User');
const AIFeedback = require('../models/AIFeedback');

class PersonalizationService {
  /**
   * Pobierz pełny profil użytkownika
   */
  static async getUserProfile(userId) {
    try {
      const [
        preferences,
        orderHistory,
        feedbackHistory,
        userData
      ] = await Promise.all([
        ConversationMemoryService.getUserPreferences(userId, 'concierge'),
        this.getOrderHistory(userId),
        this.getFeedbackHistory(userId),
        User.findById(userId).select('name email role location providerLevel providerTier').lean()
      ]);

      return {
        userId,
        preferences,
        orderHistory: {
          total: orderHistory.total,
          recent: orderHistory.recent,
          services: orderHistory.services,
          averageBudget: orderHistory.averageBudget,
          preferredUrgency: orderHistory.preferredUrgency
        },
        feedbackHistory: {
          averageRating: feedbackHistory.averageRating,
          satisfactionRate: feedbackHistory.satisfactionRate,
          commonIssues: feedbackHistory.commonIssues
        },
        userData: {
          name: userData?.name,
          role: userData?.role,
          location: userData?.location,
          level: userData?.providerLevel || userData?.providerTier
        },
        communicationStyle: this.inferCommunicationStyle(preferences, feedbackHistory),
        expertiseLevel: this.inferExpertiseLevel(orderHistory, feedbackHistory)
      };
    } catch (error) {
      console.error('Error getting user profile:', error);
      return this.getDefaultProfile(userId);
    }
  }

  /**
   * Pobierz historię zleceń użytkownika
   */
  static async getOrderHistory(userId, limit = 20) {
    try {
      const orders = await Order.find({ client: userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('service description urgency budget status createdAt')
        .lean();

      // Analiza historii
      const services = {};
      const urgencies = {};
      let totalBudget = 0;
      let budgetCount = 0;

      orders.forEach(order => {
        // Licz usługi
        const service = order.service || 'inne';
        services[service] = (services[service] || 0) + 1;

        // Licz pilności
        const urgency = order.urgency || 'flexible';
        urgencies[urgency] = (urgencies[urgency] || 0) + 1;

        // Budżet
        if (order.budget) {
          totalBudget += order.budget;
          budgetCount++;
        }
      });

      // Najczęstsza usługa
      const topService = Object.keys(services).reduce((a, b) => 
        services[a] > services[b] ? a : b, 'inne'
      );

      // Najczęstsza pilność
      const topUrgency = Object.keys(urgencies).reduce((a, b) => 
        urgencies[a] > urgencies[b] ? a : b, 'flexible'
      );

      return {
        total: orders.length,
        recent: orders.slice(0, 5),
        services,
        topService,
        averageBudget: budgetCount > 0 ? totalBudget / budgetCount : null,
        preferredUrgency: topUrgency
      };
    } catch (error) {
      console.error('Error getting order history:', error);
      return {
        total: 0,
        recent: [],
        services: {},
        topService: 'inne',
        averageBudget: null,
        preferredUrgency: 'flexible'
      };
    }
  }

  /**
   * Pobierz historię feedbacku
   */
  static async getFeedbackHistory(userId, limit = 50) {
    try {
      const feedbacks = await AIFeedback.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('feedback rating comment agent')
        .lean();

      const ratings = feedbacks
        .map(f => f.feedback?.rating)
        .filter(r => r !== null && r !== undefined);

      const averageRating = ratings.length > 0
        ? ratings.reduce((a, b) => a + b, 0) / ratings.length
        : null;

      const positiveCount = feedbacks.filter(f => 
        f.quickFeedback === 'positive' || (f.feedback?.rating && f.feedback.rating >= 4)
      ).length;

      const satisfactionRate = feedbacks.length > 0
        ? (positiveCount / feedbacks.length) * 100
        : null;

      // Najczęstsze problemy (z komentarzy negatywnych)
      const negativeComments = feedbacks
        .filter(f => f.quickFeedback === 'negative' || (f.feedback?.rating && f.feedback.rating <= 2))
        .map(f => f.feedback?.comment)
        .filter(c => c && c.length > 0);

      return {
        total: feedbacks.length,
        averageRating,
        satisfactionRate,
        commonIssues: negativeComments.slice(0, 5)
      };
    } catch (error) {
      console.error('Error getting feedback history:', error);
      return {
        total: 0,
        averageRating: null,
        satisfactionRate: null,
        commonIssues: []
      };
    }
  }

  /**
   * Wywnioskuj styl komunikacji użytkownika
   */
  static inferCommunicationStyle(preferences, feedbackHistory) {
    // Na podstawie preferencji i feedbacku
    if (preferences && preferences.communicationStyle) {
      return preferences.communicationStyle;
    }

    // Wywnioskuj z feedbacku
    if (feedbackHistory && feedbackHistory.averageRating && feedbackHistory.averageRating >= 4.5) {
      return 'detailed'; // Użytkownik docenia szczegółowe odpowiedzi
    }

    if (feedbackHistory && feedbackHistory.commonIssues && feedbackHistory.commonIssues.some(issue => 
      issue?.toLowerCase().includes('zbyt dług') || 
      issue?.toLowerCase().includes('za dużo')
    )) {
      return 'brief'; // Użytkownik preferuje krótkie odpowiedzi
    }

    return 'casual'; // Domyślnie
  }

  /**
   * Wywnioskuj poziom ekspertyzy użytkownika
   */
  static inferExpertiseLevel(orderHistory, feedbackHistory) {
    // Jeśli ma dużo zleceń i wysokie ratingi - ekspert
    if (orderHistory.total > 10 && feedbackHistory.averageRating >= 4.5) {
      return 'expert';
    }

    // Jeśli ma kilka zleceń - średnio zaawansowany
    if (orderHistory.total > 3) {
      return 'intermediate';
    }

    // Nowy użytkownik
    return 'beginner';
  }

  /**
   * Dostosuj prompt do profilu użytkownika
   */
  static personalizePrompt(basePrompt, userProfile) {
    let personalizedPrompt = basePrompt;

    // Dostosuj styl komunikacji
    const styleHints = {
      'formal': 'Używaj formalnego języka, pełnych zdań, unikaj skrótów.',
      'casual': 'Używaj przyjaznego, swobodnego języka, możesz używać skrótów.',
      'brief': 'Odpowiadaj zwięźle, konkretnie, bez zbędnych słów.',
      'detailed': 'Odpowiadaj szczegółowo, wyjaśniaj kontekst, podawaj przykłady.'
    };

    if (userProfile.communicationStyle && styleHints[userProfile.communicationStyle]) {
      personalizedPrompt += `\n\nStyl komunikacji: ${styleHints[userProfile.communicationStyle]}`;
    }

    // Dostosuj do poziomu ekspertyzy
    const expertiseHints = {
      'beginner': 'Użytkownik jest nowy - wyjaśniaj podstawy, używaj prostego języka.',
      'intermediate': 'Użytkownik ma doświadczenie - możesz używać terminów technicznych.',
      'expert': 'Użytkownik jest doświadczony - możesz być bardziej techniczny i szczegółowy.'
    };

    if (userProfile.expertiseLevel && expertiseHints[userProfile.expertiseLevel]) {
      personalizedPrompt += `\n\nPoziom ekspertyzy: ${expertiseHints[userProfile.expertiseLevel]}`;
    }

    // Dodaj kontekst z historii
    if (userProfile.orderHistory.topService && userProfile.orderHistory.topService !== 'inne') {
      personalizedPrompt += `\n\nUżytkownik często korzysta z usługi: ${userProfile.orderHistory.topService}`;
    }

    if (userProfile.orderHistory.preferredUrgency) {
      personalizedPrompt += `\n\nUżytkownik preferuje pilność: ${userProfile.orderHistory.preferredUrgency}`;
    }

    // Dodaj preferencje lokalizacyjne
    if (userProfile.preferences && userProfile.preferences.preferredLocations && userProfile.preferences.preferredLocations.length > 0) {
      personalizedPrompt += `\n\nPreferowane lokalizacje: ${userProfile.preferences.preferredLocations.join(', ')}`;
    }

    return personalizedPrompt;
  }

  /**
   * Dostosuj odpowiedź do użytkownika (post-processing)
   */
  static personalizeResponse(response, userProfile) {
    // Jeśli użytkownik preferuje brief, skróć odpowiedź
    if (userProfile.communicationStyle === 'brief' && response.reply) {
      // Skróć odpowiedź do max 2-3 zdań jeśli jest długa
      const sentences = response.reply.split(/[.!?]+/).filter(s => s.trim().length > 0);
      if (sentences.length > 3) {
        response.reply = sentences.slice(0, 3).join('. ') + '.';
      }
    }

    // Jeśli użytkownik jest beginner, dodaj więcej wyjaśnień
    if (userProfile.expertiseLevel === 'beginner' && response.reply) {
      // Można dodać dodatkowe wyjaśnienia (implementacja później)
    }

    return response;
  }

  /**
   * Pobierz domyślny profil (dla nowych użytkowników)
   */
  static getDefaultProfile(userId) {
    return {
      userId,
      preferences: {
        preferredServices: [],
        preferredLocations: [],
        communicationStyle: 'casual',
        urgencyPattern: 'mixed'
      },
      orderHistory: {
        total: 0,
        recent: [],
        services: {},
        topService: 'inne',
        averageBudget: null,
        preferredUrgency: 'flexible'
      },
      feedbackHistory: {
        averageRating: null,
        satisfactionRate: null,
        commonIssues: []
      },
      userData: {},
      communicationStyle: 'casual',
      expertiseLevel: 'beginner'
    };
  }

  /**
   * Aktualizuj profil na podstawie nowej interakcji
   */
  static async updateProfileFromInteraction(userId, interaction) {
    try {
      // Aktualizuj preferencje w ConversationMemory
      if (interaction.detectedService) {
        await ConversationMemoryService.updatePreferences(
          userId,
          interaction.sessionId || 'default',
          {
            preferredServices: [interaction.detectedService]
          },
          'concierge'
        );
      }

      if (interaction.location) {
        await ConversationMemoryService.updatePreferences(
          userId,
          interaction.sessionId || 'default',
          {
            preferredLocations: [interaction.location]
          },
          'concierge'
        );
      }
    } catch (error) {
      console.error('Error updating profile from interaction:', error);
    }
  }
}

module.exports = PersonalizationService;

