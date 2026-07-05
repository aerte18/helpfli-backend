const User = require('../models/User');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Payment = require('../models/Payment');
const Rating = require('../models/Rating');
const Message = require('../models/Message');
const Report = require('../models/Report');
const Company = require('../models/Company');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/** Zlecenia uznane za zakończone — można zamknąć konto. */
const ORDER_TERMINAL_STATUSES = ['completed', 'rated', 'cancelled', 'released'];

const OPEN_DISPUTE_STATUSES = ['reported', 'refund_requested', 'mediation', 'escalated', 'open'];

class PrivacyService {
  _anonLabel(userId) {
    const uid = String(userId);
    return `Użytkownik_${uid.slice(-8)}`;
  }

  _closedEmail(userId) {
    const uid = String(userId);
    return `closed.${uid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}@deleted.helpfli.pl`;
  }

  /**
   * Warunki blokujące samodzielne zamknięcie konta.
   * @returns {{ canDelete: boolean, blockers: Array<{ code: string, message: string }> }}
   */
  async getAccountDeletionBlockers(userId) {
    const blockers = [];
    const uid = new mongoose.Types.ObjectId(String(userId));

    const ownedCompany = await Company.findOne({ owner: uid, isActive: true }).select('_id').lean();
    if (ownedCompany) {
      blockers.push({
        code: 'COMPANY_OWNER',
        message:
          'Jesteś właścicielem aktywnej firmy w systemie. Przenieś własność firmy na innego użytkownika lub skontaktuj się z pomocą techniczną przed zamknięciem konta.',
      });
    }

    const activeOrders = await Order.countDocuments({
      $or: [{ client: uid }, { provider: uid }],
      status: { $nin: ORDER_TERMINAL_STATUSES },
    });
    if (activeOrders > 0) {
      blockers.push({
        code: 'ACTIVE_ORDERS',
        message: `Masz ${activeOrders} zleceń w toku lub niezakończonych. Dokończ je lub anuluj przed usunięciem konta.`,
      });
    }

    const openDisputes = await Order.countDocuments({
      $and: [
        { $or: [{ client: uid }, { provider: uid }] },
        {
          $or: [
            { status: 'disputed' },
            { disputeStatus: { $in: OPEN_DISPUTE_STATUSES } },
          ],
        },
      ],
    });
    if (openDisputes > 0) {
      blockers.push({
        code: 'OPEN_DISPUTE',
        message:
          'Masz otwarte spory lub wnioski o zwrot. Zamknij je lub skontaktuj się z pomocą techniczną przed usunięciem konta.',
      });
    }

    const pendingPayments = await Payment.countDocuments({
      $or: [
        { client: uid, status: { $in: ['requires_payment_method', 'processing'] } },
        { provider: uid, status: { $in: ['requires_payment_method', 'processing'] } },
        { subscriptionUser: uid, status: { $in: ['requires_payment_method', 'processing'] } },
      ],
    });
    if (pendingPayments > 0) {
      blockers.push({
        code: 'PENDING_PAYMENTS',
        message: 'Masz oczekujące płatności w systemie. Dokończ lub anuluj je przed usunięciem konta.',
      });
    }

    return { canDelete: blockers.length === 0, blockers };
  }

  /** Usuń użytkownika z list managera/wykonawcy firm (właściciel musi być obsłużony osobno). */
  async detachUserFromCompanies(userId) {
    const uid = new mongoose.Types.ObjectId(String(userId));
    await Company.updateMany({ managers: uid }, { $pull: { managers: uid } });
    await Company.updateMany({ providers: uid }, { $pull: { providers: uid } });
  }

  // Anonimizacja danych użytkownika (zgodnie z RODO)
  async anonymizeUserData(userId, options = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('Użytkownik nie istnieje');
      }
      if (user.anonymized || user.deletedAt) {
        return { success: true, message: 'Konto było już zamknięte' };
      }

      await this.detachUserFromCompanies(userId);

      const label = this._anonLabel(userId);
      const closedEmail = this._closedEmail(userId);
      const randomPwd = crypto.randomBytes(32).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPwd, 10);

      const anonymizedData = {
        name: label,
        email: closedEmail,
        password: hashedPassword,
        phone: null,
        address: null,
        location: null,
        locationCoords: { lat: 0, lng: 0 },
        bio: '',
        headline: '',
        priceNote: '',
        availability: '',
        avatar: 'https://via.placeholder.com/150',
        pushSubs: [],
        twoFactorEnabled: false,
        'provider_status.isOnline': false,
        emailVerified: false,
        marketingConsent: false,
        'consents.analytics': false,
        'consents.cookies': false,
        'consents.updatedAt': new Date(),
        company: null,
        roleInCompany: 'none',
        stripeAccountId: '',
        stripeCustomerId: null,
        'stripeConnectStatus.chargesEnabled': false,
        'stripeConnectStatus.payoutsEnabled': false,
        'stripeConnectStatus.detailsSubmitted': false,
        'stripeConnectStatus.requirementsDue': false,
        'stripeConnectStatus.lastCheckedAt': null,
        'billing.companyName': '',
        'billing.nip': '',
        'billing.street': '',
        'billing.city': '',
        'billing.postalCode': '',
        'billing.wantInvoice': false,
        'kyc.firstName': null,
        'kyc.lastName': null,
        'kyc.idNumber': null,
        'kyc.companyName': null,
        'kyc.nip': null,
        'kyc.docs.idFrontUrl': null,
        'kyc.docs.idBackUrl': null,
        'kyc.docs.selfieUrl': null,
        'kyc.docs.companyDocUrl': null,
        anonymizedAt: new Date(),
        anonymized: true,
        isActive: false,
        deletedAt: new Date(),
      };

      if (options.clearCompanyInvitation) {
        anonymizedData.companyInvitation = undefined;
      }

      await User.findByIdAndUpdate(userId, {
        $set: anonymizedData,
        $unset: {
          referralCode: '',
          twoFactorSecret: '',
          twoFactorBackupCodes: '',
          passwordResetToken: '',
          passwordResetExpires: '',
          emailVerificationToken: '',
          emailVerificationExpires: '',
          companyRoleId: '',
        },
      });

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
    const placeholderMsg = '[Wiadomość usunięta — konto użytkownika zostało zamknięte]';
    const placeholderComment = '[Komentarz usunięty — konto użytkownika zostało zamknięte]';

    operations.push(
      Message.updateMany(
        { sender: userId },
        {
          $set: {
            text: placeholderMsg,
          },
        }
      )
    );

    operations.push(
      Rating.updateMany(
        { to: userId },
        {
          $set: {
            comment: placeholderComment,
          },
        }
      )
    );

    operations.push(
      Rating.updateMany(
        { from: userId },
        {
          $set: {
            comment: placeholderComment,
          },
        }
      )
    );

    operations.push(
      Event.deleteMany({ userId: new mongoose.Types.ObjectId(userId) })
    );

    await Promise.all(operations);
  }

  // Pełne usunięcie danych (tylko dla przypadków specjalnych)
  async deleteUserDataCompletely(userId) {
    try {
      const operations = [];

      operations.push(User.findByIdAndDelete(userId));
      operations.push(Order.deleteMany({ client: userId }));
      operations.push(Order.deleteMany({ provider: userId }));
      operations.push(Message.deleteMany({ sender: userId }));
      operations.push(Rating.deleteMany({ to: userId }));
      operations.push(Rating.deleteMany({ from: userId }));
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

      const [orders, ratings, messages, events, payments] = await Promise.all([
        Order.find({ $or: [{ client: userId }, { provider: userId }] }).lean(),
        Rating.find({ $or: [{ to: userId }, { from: userId }] }).lean(),
        Message.find({ sender: userId }).lean(),
        Event.find({ userId: new mongoose.Types.ObjectId(userId) }).lean(),
        Payment.find({ client: userId }).lean(),
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
            verification: user.verification,
          },
        },
        orders: orders.map((order) => ({
          id: order._id,
          service: order.service,
          description: order.description,
          status: order.status,
          amount: order.amountTotal,
          createdAt: order.createdAt,
          completedAt: order.completedAt,
        })),
        ratings: ratings.map((rating) => ({
          id: rating._id,
          rating: rating.rating,
          comment: rating.comment,
          createdAt: rating.createdAt,
          type: String(rating.to) === String(userId) ? 'received' : 'given',
        })),
        messages: messages.map((message) => ({
          id: message._id,
          text: message.text,
          conversation: message.conversation,
          createdAt: message.createdAt,
        })),
        events: events.map((event) => ({
          type: event.type,
          properties: event.properties,
          createdAt: event.createdAt,
        })),
        payments: payments.map((payment) => ({
          id: payment._id,
          amount: payment.amount,
          status: payment.status,
          createdAt: payment.createdAt,
        })),
        exportedAt: new Date(),
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
      const uid = new mongoose.Types.ObjectId(String(userId));
      const { canDelete, blockers } = await this.getAccountDeletionBlockers(userId);

      const activeOrders = await Order.countDocuments({
        $or: [{ client: uid }, { provider: uid }],
        status: { $nin: ORDER_TERMINAL_STATUSES },
      });

      const pendingPayments = await Payment.countDocuments({
        $or: [
          { client: uid, status: { $in: ['requires_payment_method', 'processing'] } },
          { provider: uid, status: { $in: ['requires_payment_method', 'processing'] } },
          { subscriptionUser: uid, status: { $in: ['requires_payment_method', 'processing'] } },
        ],
      });

      return {
        canDelete,
        activeOrders,
        pendingPayments,
        reason: blockers[0]?.message || null,
        blockers,
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
        operation,
        details,
        timestamp: new Date(),
        ip: details.ip || null,
        userAgent: details.userAgent || null,
      };

      console.log('[PRIVACY_AUDIT]', auditLog);

      return auditLog;
    } catch (error) {
      console.error('Privacy audit log error:', error);
    }
  }
}

module.exports = new PrivacyService();
