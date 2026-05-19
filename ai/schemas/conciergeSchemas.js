/**
 * Schematy walidacji dla AI Concierge Agentów
 * Wszystkie odpowiedzi agentów muszą przejść przez te schematy
 */

function validateConciergeRequest(body) {
  const userContext = body.userContext || {};
  
  // Backward compatibility: jeśli jest description (stary format), zamień na messages
  if (body.description && typeof body.description === 'string' && body.description.trim().length > 0) {
    return {
      messages: [{ role: 'user', content: body.description.trim() }],
      userContext: {
        location: body.locationText ? (typeof body.locationText === 'string' ? { text: body.locationText } : body.locationText) : userContext.location,
        lat: body.lat || userContext.lat,
        lng: body.lon || body.lng || userContext.lng,
        userId: userContext.userId
      },
      imageUrls: body.imageUrls || [],
      allowedServicesHint: body.allowedServicesHint || []
    };
  }

  // Nowy format: messages array
  const messages = body.messages || body.conversationHistory || [];
  
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array or provide description');
  }

  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new Error('Invalid message object');
    if (m.role && !['user', 'assistant', 'system'].includes(m.role)) {
      throw new Error('Invalid role in messages. Must be: user, assistant, or system');
    }
    const content = m.content || m.text || '';
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Message content required');
    }
  }

  const chosenPath = body.chosenPath && typeof body.chosenPath === 'string' ? body.chosenPath.trim() : null;

  return {
    messages: messages.map(m => ({
      role: m.role || 'user',
      content: m.content || m.text || ''
    })),
    userContext: userContext && typeof userContext === 'object' ? userContext : {},
    imageUrls: Array.isArray(body.imageUrls) ? body.imageUrls : [],
    allowedServicesHint: Array.isArray(body.allowedServicesHint) ? body.allowedServicesHint : [],
    sessionId: body.sessionId || null,
    chosenPath: chosenPath || null
  };
}

const VALID_URGENCIES = ['low', 'standard', 'urgent'];
const VALID_NEXT_STEPS = [
  'ask_more',
  'diagnose',
  'show_pricing',
  'suggest_diy',
  'suggest_providers',
  'create_order',
  'offer_choices'
];

function coerceConciergeResponseShape(ai) {
  if (!ai || typeof ai !== 'object') return ai;
  if (typeof ai.reply !== 'string' || !ai.reply.trim()) {
    ai.reply = 'Rozumiem — sprawdzam dalej.';
  } else {
    ai.reply = ai.reply.trim();
  }
  if (typeof ai.detectedService !== 'string' || !ai.detectedService.trim()) {
    ai.detectedService = 'inne';
  }
  if (!VALID_URGENCIES.includes(ai.urgency)) {
    ai.urgency = 'standard';
  }
  if (typeof ai.confidence !== 'number' || Number.isNaN(ai.confidence)) {
    ai.confidence = 0.75;
  } else {
    ai.confidence = Math.min(1, Math.max(0, ai.confidence));
  }
  if (!VALID_NEXT_STEPS.includes(ai.nextStep)) {
    ai.nextStep = 'ask_more';
  }
  if (!Array.isArray(ai.questions)) {
    ai.questions = [];
  }
  return ai;
}

function validateConciergeResponseShape(ai) {
  if (!ai || typeof ai !== 'object') {
    throw new Error('AI response must be an object');
  }
  coerceConciergeResponseShape(ai);
  if (typeof ai.reply !== 'string' || ai.reply.trim().length === 0) {
    throw new Error('AI.reply must be a non-empty string');
  }
  if (typeof ai.detectedService !== 'string') {
    throw new Error('AI.detectedService must be string');
  }
  if (!VALID_URGENCIES.includes(ai.urgency)) {
    throw new Error(`AI.urgency must be one of: ${VALID_URGENCIES.join(', ')}`);
  }
  if (typeof ai.confidence !== 'number' || ai.confidence < 0 || ai.confidence > 1) {
    throw new Error('AI.confidence must be a number between 0 and 1');
  }
  if (!VALID_NEXT_STEPS.includes(ai.nextStep)) {
    throw new Error(`AI.nextStep must be one of: ${VALID_NEXT_STEPS.join(', ')}`);
  }
  if (!Array.isArray(ai.questions)) {
    throw new Error('AI.questions must be an array');
  }
}

function validateDiagnosticResponse(ai) {
  if (!ai || typeof ai !== 'object') throw new Error('Diagnostic response must be an object');
  if (!['low', 'standard', 'urgent'].includes(ai.urgency)) {
    throw new Error('Invalid urgency in diagnostic response');
  }
  if (!['none', 'medium', 'high'].includes(ai.risk)) {
    throw new Error('Invalid risk in diagnostic response');
  }
  if (!['express', 'provider', 'diy', 'teleconsult'].includes(ai.recommendedPath)) {
    throw new Error('Invalid recommendedPath in diagnostic response');
  }
}

function validatePricingResponse(ai) {
  if (!ai || typeof ai !== 'object') throw new Error('Pricing response must be an object');
  if (!ai.ranges || typeof ai.ranges !== 'object') {
    throw new Error('Pricing response must have ranges object');
  }
  ['basic', 'standard', 'pro'].forEach(level => {
    if (!ai.ranges[level] || typeof ai.ranges[level] !== 'object') {
      throw new Error(`Pricing response must have ranges.${level}`);
    }
    if (typeof ai.ranges[level].min !== 'number' || typeof ai.ranges[level].max !== 'number') {
      throw new Error(`Pricing ranges.${level} must have min and max as numbers`);
    }
  });
}

function validateDIYResponse(ai) {
  if (!ai || typeof ai !== 'object') throw new Error('DIY response must be an object');
  if (!Array.isArray(ai.steps) || ai.steps.length === 0) {
    throw new Error('DIY response must have non-empty steps array');
  }
  if (!['easy', 'medium', 'hard'].includes(ai.difficulty)) {
    throw new Error('DIY response must have valid difficulty');
  }
}

function validateMatchingResponse(ai) {
  if (!ai || typeof ai !== 'object') throw new Error('Matching response must be an object');
  if (!Array.isArray(ai.topProviders)) {
    throw new Error('Matching response must have topProviders array');
  }
}

function validateOrderDraftResponse(ai) {
  if (!ai || typeof ai !== 'object') throw new Error('Order draft response must be an object');
  if (typeof ai.canCreate !== 'boolean') {
    throw new Error('Order draft response must have canCreate boolean');
  }
  if (ai.canCreate && (!ai.orderPayload || typeof ai.orderPayload !== 'object')) {
    throw new Error('Order draft response must have orderPayload when canCreate is true');
  }
}

module.exports = {
  validateConciergeRequest,
  coerceConciergeResponseShape,
  validateConciergeResponseShape,
  validateDiagnosticResponse,
  validatePricingResponse,
  validateDIYResponse,
  validateMatchingResponse,
  validateOrderDraftResponse
};

