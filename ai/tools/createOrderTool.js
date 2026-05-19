/**
 * Tool: createOrder
 * Tworzy nowe zlecenie na podstawie danych z konwersacji
 */

const Order = require('../../models/Order');
const Service = require('../../models/Service');
const { mergeAttachmentLists } = require('../utils/orderConciergeSync');

function buildAiBrief(params, context) {
  if (context.aiBrief) return context.aiBrief;
  const brief = params.aiBrief;
  if (brief && typeof brief === 'object') return brief;
  return null;
}

function normalizeLocation(location, context) {
  if (!location && context.locationText) {
    return typeof context.locationText === 'string'
      ? context.locationText
      : context.locationText.text || String(context.locationText);
  }
  if (typeof location === 'object') {
    return location.address || location.text || location.city || JSON.stringify(location);
  }
  return location;
}

async function createOrderTool(params, context = {}) {
  try {
    const {
      service,
      description,
      location,
      urgency = 'standard',
      budget = null,
      preferredTime = null,
      attachments = []
    } = params;
    const userId = context.userId;

    if (!userId) {
      throw new Error('User ID required');
    }

    if (!service) {
      throw new Error('Service is required');
    }
    if (!description) {
      throw new Error('Description is required');
    }

    const locationValue = normalizeLocation(location, context);
    if (!locationValue) {
      throw new Error('Location is required');
    }

    let serviceObj = null;
    let serviceValue = service;

    if (service) {
      serviceObj = await Service.findOne({
        $or: [
          { slug: service },
          { name_pl: { $regex: service, $options: 'i' } },
          { name_en: { $regex: service, $options: 'i' } }
        ]
      }).lean();

      if (serviceObj) {
        serviceValue = serviceObj.slug;
      }
    } else {
      serviceObj = await Service.findOne({ slug: 'inne' }).lean();
      serviceValue = serviceObj?.slug || 'inne';
    }

    const urgencyMap = {
      low: 'flexible',
      standard: 'today',
      urgent: 'now',
      normal: 'flexible',
      high: 'today'
    };
    const mappedUrgency = urgencyMap[urgency] || urgency || 'flexible';
    const validUrgency = ['now', 'today', 'tomorrow', 'this_week', 'flexible'].includes(mappedUrgency)
      ? mappedUrgency
      : 'flexible';

    const mergedAttachments = mergeAttachmentLists(
      context.attachments,
      attachments,
      context.imageUrls
    );

    let fullDescription = String(description || '').trim();
    const timeHint = preferredTime || context.preferredTime || context.extracted?.timeWindow;
    if (timeHint && !fullDescription.toLowerCase().includes(String(timeHint).toLowerCase().slice(0, 4))) {
      fullDescription = `${fullDescription}\n\nPreferowany termin: ${timeHint}`.trim();
    }

    const aiBrief = buildAiBrief(params, context);
    const budgetMid = budget && (budget.min != null || budget.max != null)
      ? Math.round(((Number(budget.min) || 0) + (Number(budget.max) || Number(budget.min) || 0)) / 2)
      : null;

    const order = await Order.create({
      client: userId,
      service: serviceValue,
      description: fullDescription.slice(0, 2000) || 'Zlecenie utworzone przez AI Concierge',
      location: locationValue,
      city: typeof locationValue === 'string' ? locationValue.split(',')[0].trim() : '',
      urgency: validUrgency,
      status: 'open',
      source: 'ai',
      budget: budgetMid,
      budgetRange: budget || null,
      attachments: mergedAttachments,
      ...(aiBrief ? { aiBrief } : {}),
      createdAt: new Date()
    });

    const populatedOrder = await Order.findById(order._id)
      .populate('client', 'name email')
      .lean();

    return {
      success: true,
      orderId: order._id.toString(),
      order: {
        id: populatedOrder._id.toString(),
        service: populatedOrder.service,
        description: populatedOrder.description,
        location: populatedOrder.location,
        urgency: populatedOrder.urgency,
        status: populatedOrder.status,
        budget: populatedOrder.budget,
        attachmentsCount: (populatedOrder.attachments || []).length
      },
      message: `Zlecenie zostało utworzone pomyślnie (ID: ${order._id})`
    };
  } catch (error) {
    console.error('createOrderTool error:', error);
    throw new Error(`Failed to create order: ${error.message}`);
  }
}

module.exports = createOrderTool;
