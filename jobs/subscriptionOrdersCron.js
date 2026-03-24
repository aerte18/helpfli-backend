/**
 * Cron job do automatycznego tworzenia cyklicznych zleceń dla subscription
 * Sprawdza zlecenia z isSubscription=true i tworzy nowe zlecenia zgodnie z subscriptionFrequency
 */

const Order = require('../models/Order');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Oblicz następną datę zlecenia na podstawie subscriptionType i subscriptionFrequency
 */
function calculateNextOrderDate(subscriptionType, subscriptionFrequency, lastOrderDate) {
  const baseDate = lastOrderDate || new Date();
  const nextDate = new Date(baseDate);
  
  switch (subscriptionType) {
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'biweekly':
      nextDate.setDate(nextDate.getDate() + 14);
      break;
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case 'custom':
      if (subscriptionFrequency && subscriptionFrequency > 0) {
        nextDate.setDate(nextDate.getDate() + subscriptionFrequency);
      } else {
        return null; // Nieprawidłowa częstotliwość
      }
      break;
    default:
      return null;
  }
  
  return nextDate;
}

/**
 * Utwórz nowe zlecenie na podstawie template order (subscription)
 */
async function createSubscriptionOrder(templateOrder) {
  try {
    const newOrder = await Order.create({
      client: templateOrder.client,
      service: templateOrder.service,
      serviceDetails: templateOrder.serviceDetails,
      description: templateOrder.description,
      location: templateOrder.location,
      locationLat: templateOrder.locationLat,
      locationLon: templateOrder.locationLon,
      city: templateOrder.city,
      status: 'open',
      urgency: templateOrder.urgency || 'flexible',
      budget: templateOrder.budget,
      budgetRange: templateOrder.budgetRange,
      paymentMethod: templateOrder.paymentMethod || 'system',
      paymentPreference: templateOrder.paymentPreference || 'system',
      priority: templateOrder.priority || 'normal',
      // Subscription fields
      isSubscription: true,
      subscriptionType: templateOrder.subscriptionType,
      subscriptionFrequency: templateOrder.subscriptionFrequency,
      subscriptionStartDate: templateOrder.subscriptionStartDate,
      subscriptionEndDate: templateOrder.subscriptionEndDate,
      subscriptionTemplateId: templateOrder._id, // Powiąż z template order
      // Delivery fields (jeśli były w template)
      deliveryAddress: templateOrder.deliveryAddress,
      deliveryMethod: templateOrder.deliveryMethod,
      // Consultation fields (jeśli były w template)
      isTeleconsultation: templateOrder.isTeleconsultation,
      consultationType: templateOrder.consultationType,
      consultationDuration: templateOrder.consultationDuration,
      // Metadata
      createdAt: new Date(),
      // Nie kopiuj provider - nowe zlecenie powinno być otwarte dla wszystkich
      provider: null
    });
    
    logger.info(`✅ Utworzono nowe zlecenie subscription: ${newOrder._id} dla template: ${templateOrder._id}`);
    return newOrder;
  } catch (error) {
    logger.error(`❌ Błąd tworzenia zlecenia subscription: ${error.message}`, {
      templateOrderId: templateOrder._id,
      error: error.stack
    });
    throw error;
  }
}

/**
 * Główna funkcja cron job - sprawdza i tworzy nowe zlecenia subscription
 */
async function processSubscriptionOrders() {
  try {
    const now = new Date();
    logger.info('🔄 Starting subscription orders cron job...');
    
    // Znajdź wszystkie aktywne zlecenia subscription (template orders)
    // Template order to zlecenie z isSubscription=true, które ma subscriptionStartDate i subscriptionEndDate (lub null)
    const templateOrders = await Order.find({
      isSubscription: true,
      subscriptionStartDate: { $exists: true, $ne: null },
      $or: [
        { subscriptionEndDate: null }, // Bez końca
        { subscriptionEndDate: { $gte: now } } // Nie przekroczono końca
      ]
    }).populate('client', 'name email');
    
    logger.info(`📋 Znaleziono ${templateOrders.length} template orders subscription`);
    
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const template of templateOrders) {
      try {
        // Sprawdź czy template ma wszystkie wymagane pola
        if (!template.subscriptionType) {
          logger.warn(`⚠️ Template order ${template._id} nie ma subscriptionType - pomijam`);
          skippedCount++;
          continue;
        }
        
        // Znajdź ostatnie zlecenie utworzone z tego template (po dacie subscriptionStartDate)
        // Zakładamy że ostatnie zlecenie ma podobne dane ale jest młodsze niż template
        // W rzeczywistości możemy oznaczyć template order jako "parent" i śledzić związane zlecenia
        // Na razie uproszczone podejście: sprawdź ostatnie zlecenie tego klienta z tym samym service
        
        // Sprawdź czy już nie utworzyliśmy zlecenia w tym cyklu
        // Uproszczenie: jeśli minął czas od subscriptionStartDate zgodnie z frequency, utwórz nowe
        
        const startDate = template.subscriptionStartDate || template.createdAt;
        const nextOrderDate = calculateNextOrderDate(
          template.subscriptionType,
          template.subscriptionFrequency,
          startDate
        );
        
        if (!nextOrderDate) {
          logger.warn(`⚠️ Template order ${template._id} ma nieprawidłowy subscriptionType/frequency - pomijam`);
          skippedCount++;
          continue;
        }
        
        // Sprawdź czy czas na nowe zlecenie (nextOrderDate <= now)
        if (nextOrderDate > now) {
          // Jeszcze nie czas - pomiń
          continue;
        }
        
        // Sprawdź czy już nie utworzyliśmy zlecenia w tym okresie
        // Znajdź ostatnie zlecenie utworzone z tego template
        const lastOrder = await Order.findOne({
          subscriptionTemplateId: template._id,
          createdAt: { $gte: new Date(nextOrderDate.getTime() - 24 * 60 * 60 * 1000) } // W ciągu ostatnich 24h
        }).sort({ createdAt: -1 });
        
        if (lastOrder) {
          // Zlecenie już zostało utworzone w tym okresie - pomiń
          logger.info(`⏭️ Zlecenie subscription już utworzone dla template ${template._id} - pomijam`);
          skippedCount++;
          continue;
        }
        
        // Utwórz nowe zlecenie
        const newOrder = await createSubscriptionOrder(template);
        createdCount++;
        
        // Aktualizuj subscriptionStartDate w template na nextOrderDate (dla następnego cyklu)
        template.subscriptionStartDate = nextOrderDate;
        await template.save();
        
        logger.info(`✅ Utworzono zlecenie subscription ${newOrder._id} z template ${template._id}, następny cykl: ${nextOrderDate.toISOString()}`);
        
      } catch (templateError) {
        logger.error(`❌ Błąd przetwarzania template ${template._id}: ${templateError.message}`);
        errorCount++;
      }
    }
    
    logger.info(`✅ Subscription orders cron job zakończony: ${createdCount} utworzonych, ${skippedCount} pominiętych, ${errorCount} błędów`);
    
    return {
      success: true,
      created: createdCount,
      skipped: skippedCount,
      errors: errorCount
    };
    
  } catch (error) {
    logger.error(`❌ Błąd w subscription orders cron job: ${error.message}`, {
      error: error.stack
    });
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  processSubscriptionOrders
};
