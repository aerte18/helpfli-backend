/**
 * Tool: createOrder
 * Tworzy nowe zlecenie na podstawie danych z konwersacji
 */

const Order = require('../../models/Order');
const Service = require('../../models/Service');

async function createOrderTool(params, context) {
  try {
    const { service, description, location, urgency = 'standard', budget = null } = params;
    const userId = context.userId;

    if (!userId) {
      throw new Error('User ID required');
    }

    // Walidacja wymaganych parametrów
    if (!service) {
      throw new Error('Service is required');
    }
    if (!description) {
      throw new Error('Description is required');
    }
    if (!location) {
      throw new Error('Location is required');
    }

    // Sprawdź czy service istnieje (Service używa 'slug' a nie 'code')
    let serviceObj = null;
    let serviceValue = service; // Będzie użyte jako string w Order.service
    
    if (service) {
      // Spróbuj znaleźć po slug lub name
      serviceObj = await Service.findOne({
        $or: [
          { slug: service },
          { name_pl: { $regex: service, $options: 'i' } },
          { name_en: { $regex: service, $options: 'i' } }
        ]
      }).lean();

      if (serviceObj) {
        // Użyj slug jako service value
        serviceValue = serviceObj.slug;
      } else {
        // Fallback: użyj podanego service jako string (może to być już slug/code)
        serviceValue = service;
      }
    } else {
      // Brak service - użyj 'inne' jako fallback
      serviceObj = await Service.findOne({ slug: 'inne' }).lean();
      serviceValue = serviceObj?.slug || 'inne';
    }

    // Mapuj urgency na poprawne wartości
    const urgencyMap = {
      'low': 'flexible',
      'standard': 'today',
      'urgent': 'now',
      'normal': 'flexible',
      'high': 'today'
    };
    const mappedUrgency = urgencyMap[urgency] || urgency || 'flexible';
    
    // Sprawdź czy urgency jest poprawne (enum values)
    const validUrgency = ['now', 'today', 'tomorrow', 'this_week', 'flexible'].includes(mappedUrgency)
      ? mappedUrgency
      : 'flexible';

    // Utwórz zlecenie (Order.service jest String - slug/code jako string)
    const order = await Order.create({
      client: userId,
      service: serviceValue, // String - slug lub code
      description: description || 'Zlecenie utworzone przez AI Concierge',
      location: location || 'Nieznana lokalizacja',
      urgency: validUrgency,
      status: 'open',
      budget: budget ? (budget.min + budget.max) / 2 : null,
      budgetRange: budget || null,
      createdAt: new Date()
    });

    // Populate dla response (jeśli service to ObjectId, ale u nas jest String)
    const populatedOrder = await Order.findById(order._id)
      .populate('client', 'name email')
      .lean();

    return {
      success: true,
      orderId: order._id.toString(),
      order: {
        id: populatedOrder._id.toString(),
        service: populatedOrder.service, // String - slug
        description: populatedOrder.description,
        location: populatedOrder.location,
        urgency: populatedOrder.urgency,
        status: populatedOrder.status,
        budget: populatedOrder.budget
      },
      message: `Zlecenie zostało utworzone pomyślnie (ID: ${order._id})`
    };

  } catch (error) {
    console.error('createOrderTool error:', error);
    throw new Error(`Failed to create order: ${error.message}`);
  }
}

module.exports = createOrderTool;

