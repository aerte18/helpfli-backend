const User = require('../models/User');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Payment = require('../models/Payment');
const Rating = require('../models/Rating');
const Message = require('../models/Message');
const Report = require('../models/Report');
const mongoose = require('mongoose');

class PrivacyService {
  
  // Anonimizacja danych użytkownika (zgodnie z RODO)
  async anonymizeUserData(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('Użytkownik nie istnieje');
      }

      // Anonimizuj dane osobowe
      const anonymizedData = {
        name: `Użytkownik_${userId.slice(-8)}`,
        email: `anon_${userId}@deleted.helpfli.pl`,
        phone: null,
        address: null,
        location: null,
        locationLat: null,
        locationLon: null,
        city: null,
        
        // Anonimizuj dane KYC
        'kyc.firstName': null,
        'kyc.lastName': null,
        'kyc.idNumber': null,
        'kyc.companyName': null,
        'kyc.nip': null,
        'kyc.docs.idFrontUrl': null,
        'kyc.docs.idBackUrl': null,
        'kyc.docs.selfieUrl': null,
        'kyc.docs.companyDocUrl': null,
        
        // Oznacz jako anonimizowane
        anonymizedAt: new Date(),
        anonymized: true,
        
        // Wyłącz konto
        isActive: false,
        deletedAt: new Date()
      };

      await User.findByIdAndUpdate(userId, anonymizedData);
      
      // Anonimizuj powiązane dane
      await this.anonymizeRelatedData(userId);
      
      return { success: true, message: 'Dane użytkownika zostały anonimizowane' };
    } catch (error) {
      console.error('Anonymization error:', error);
      throw error;
    }
  }

  // Anonimizacja powiązanych danych
  async anonymizeRelatedData(userId) {
    const operations = [];

    // Anonimizuj zlecenia (zachowaj dla celów biznesowych, ale usuń dane osobowe)
    operations.push(
      Order.updateMany(
        { client: userId },
        {
          $set: {
            'clientName': `Użytkownik_${userId.slice(-8)}`,
            'clientEmail': `anon_${userId}@deleted.helpfli.pl`,
            'clientPhone': null
          }
        }
      )
    );

    operations.push(
      Order.updateMany(
        { provider: userId },
        {
          $set: {
            'providerName': `Użytkownik_${userId.slice(-8)}`,
            'providerEmail': `anon_${userId}@deleted.helpfli.pl`,
            'providerPhone': null
          }
        }
      )
    );

    // Anonimizuj wiadomości w czacie
    operations.push(
      Message.updateMany(
        { sender: userId },
        {
          $set: {
            'senderName': `Użytkownik_${userId.slice(-8)}`,
            'text': '[Wiadomość usunięta - dane użytkownika zostały anonimizowane]'
          }
        }
      )
    );

    // Anonimizuj oceny
    operations.push(
      Rating.updateMany(
        { ratedUser: userId },
        {
          $set: {
            'ratedUserName': `Użytkownik_${userId.slice(-8)}`,
            'comment': '[Komentarz usunięty - dane użytkownika zostały anonimizowane]'
          }
        }
      )
    );

    operations.push(
      Rating.updateMany(
        { rater: userId },
        {
          $set: {
            'raterName': `Użytkownik_${userId.slice(-8)}`,
            'comment': '[Komentarz usunięty - dane użytkownika zostały anonimizowane]'
          }
        }
      )
    );

    // Usuń eventy telemetry (nie potrzebujemy ich po anonimizacji)
    operations.push(
      Event.deleteMany({ userId: new mongoose.Types.ObjectId(userId) })
    );

    // Usuń raporty (zachowaj dla celów bezpieczeństwa, ale usuń dane osobowe)
    operations.push(
      Report.updateMany(
        { user: userId },
        {
          $set: {
            'userName': `Użytkownik_${userId.slice(-8)}`
          }
        }
      )
    );

    operations.push(
      Report.updateMany(
        { reportedUser: userId },
        {
          $set: {
            'reportedUserName': `Użytkownik_${userId.slice(-8)}`
          }
        }
      )
    );

    await Promise.all(operations);
  }

  // Pełne usunięcie danych (tylko dla przypadków specjalnych)
  async deleteUserDataCompletely(userId) {
    try {
      const operations = [];

      // Usuń wszystkie powiązane dane
      operations.push(User.findByIdAndDelete(userId));
      operations.push(Order.deleteMany({ client: userId }));
      operations.push(Order.deleteMany({ provider: userId }));
      operations.push(Message.deleteMany({ sender: userId }));
      operations.push(Rating.deleteMany({ ratedUser: userId }));
      operations.push(Rating.deleteMany({ rater: userId }));
      operations.push(Event.deleteMany({ userId: new mongoose.Types.ObjectId(userId) }));
      operations.push(Report.deleteMany({ user: userId }));
      operations.push(Report.deleteMany({ reportedUser: userId }));
      operations.push(Payment.deleteMany({ client: userId }));

      await Promise.all(operations);
      
      return { success: true, message: 'Wszystkie dane użytkownika zostały usunięte' };
    } catch (error) {
      console.error('Complete deletion error:', error);
      throw error;
    }
  }

  // Eksport danych użytkownika (prawo do przenoszenia danych)
  async exportUserData(userId) {
    try {
      const user = await User.findById(userId).lean();
      if (!user) {
        throw new Error('Użytkownik nie istnieje');
      }

      // Pobierz wszystkie dane użytkownika
      const [orders, ratings, messages, events, payments] = await Promise.all([
        Order.find({ $or: [{ client: userId }, { provider: userId }] }).lean(),
        Rating.find({ $or: [{ ratedUser: userId }, { rater: userId }] }).lean(),
        Message.find({ sender: userId }).lean(),
        Event.find({ userId: new mongoose.Types.ObjectId(userId) }).lean(),
        Payment.find({ client: userId }).lean()
      ]);

      const exportData = {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          profile: {
            bio: user.bio,
            services: user.services,
            rating: user.ratingAvg,
            verification: user.verification
          }
        },
        orders: orders.map(order => ({
          id: order._id,
          service: order.service,
          description: order.description,
          status: order.status,
          amount: order.amountTotal,
          createdAt: order.createdAt,
          completedAt: order.completedAt
        })),
        ratings: ratings.map(rating => ({
          id: rating._id,
          rating: rating.rating,
          comment: rating.comment,
          createdAt: rating.createdAt,
          type: rating.ratedUser.toString() === userId.toString() ? 'received' : 'given'
        })),
        messages: messages.map(message => ({
          id: message._id,
          text: message.text,
          orderId: message.orderId,
          createdAt: message.createdAt
        })),
        events: events.map(event => ({
          type: event.type,
          properties: event.properties,
          createdAt: event.createdAt
        })),
        payments: payments.map(payment => ({
          id: payment._id,
          amount: payment.amount,
          status: payment.status,
          createdAt: payment.createdAt
        })),
        exportedAt: new Date()
      };

      return exportData;
    } catch (error) {
      console.error('Data export error:', error);
      throw error;
    }
  }

  // Sprawdź czy użytkownik może usunąć dane (brak aktywnych zleceń)
  async canDeleteData(userId) {
    try {
      const activeOrders = await Order.countDocuments({
        $or: [{ client: userId }, { provider: userId }],
        status: { $in: ['open', 'accepted', 'funded', 'in_progress', 'disputed'] }
      });

      const pendingPayments = await Payment.countDocuments({
        client: userId,
        status: { $in: ['pending', 'processing'] }
      });

      return {
        canDelete: activeOrders === 0 && pendingPayments === 0,
        activeOrders,
        pendingPayments,
        reason: activeOrders > 0 ? 'Aktywne zlecenia' : 
                pendingPayments > 0 ? 'Oczekujące płatności' : null
      };
    } catch (error) {
      console.error('Can delete data check error:', error);
      return { canDelete: false, reason: 'Błąd sprawdzania' };
    }
  }

  // Audit log dla operacji RODO
  async logPrivacyOperation(userId, operation, details = {}) {
    try {
      const auditLog = {
        userId: new mongoose.Types.ObjectId(userId),
        operation, // 'anonymize', 'delete', 'export'
        details,
        timestamp: new Date(),
        ip: details.ip || null,
        userAgent: details.userAgent || null
      };

      // Zapisz do logów (można użyć dedykowanego modelu lub systemu logowania)
      console.log('[PRIVACY_AUDIT]', auditLog);
      
      return auditLog;
    } catch (error) {
      console.error('Privacy audit log error:', error);
    }
  }
}

module.exports = new PrivacyService();

