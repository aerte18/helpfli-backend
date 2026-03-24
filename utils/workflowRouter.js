const CompanyWorkflow = require('../models/CompanyWorkflow');
const Company = require('../models/Company');
const Order = require('../models/Order');
const User = require('../models/User');
const Service = require('../models/Service');

/**
 * Oblicza odległość między dwoma punktami (Haversine formula)
 * @param {Number} lat1 - Szerokość geograficzna punktu 1
 * @param {Number} lon1 - Długość geograficzna punktu 1
 * @param {Number} lat2 - Szerokość geograficzna punktu 2
 * @param {Number} lon2 - Długość geograficzna punktu 2
 * @returns {Number} Odległość w kilometrach
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Promień Ziemi w km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Pobiera lub tworzy workflow dla firmy
 * @param {String} companyId - ID firmy
 * @returns {Object} CompanyWorkflow
 */
async function getOrCreateWorkflow(companyId) {
  let workflow = await CompanyWorkflow.findOne({ company: companyId });
  
  if (!workflow) {
    workflow = await CompanyWorkflow.create({
      company: companyId,
      enabled: true
    });
  }
  
  return workflow;
}

/**
 * Pobiera kandydatów do przypisania zlecenia (członkowie zespołu firmy)
 * @param {String} companyId - ID firmy
 * @returns {Array} Lista użytkowników (providerów)
 */
async function getCompanyProviders(companyId) {
  const company = await Company.findById(companyId).populate('providers');
  if (!company) {
    return [];
  }
  
  // Pobierz tylko aktywnych providerów
  const providers = await User.find({
    _id: { $in: company.providers },
    role: 'provider',
    isActive: true
  });
  
  return providers;
}

/**
 * Strategia Round-Robin: równomierne rozłożenie zleceń
 * @param {Array} providers - Lista providerów
 * @param {Object} workflow - Workflow configuration
 * @returns {Object} Wybrany provider
 */
function roundRobinStrategy(providers, workflow) {
  if (providers.length === 0) return null;
  
  const lastIndex = workflow.routingRules.roundRobin.lastAssignedIndex || -1;
  const nextIndex = (lastIndex + 1) % providers.length;
  
  // Zaktualizuj indeks
  workflow.routingRules.roundRobin.lastAssignedIndex = nextIndex;
  workflow.save().catch(err => console.error('Error saving workflow:', err));
  
  return providers[nextIndex];
}

/**
 * Strategia Location-Based: przypisanie na podstawie lokalizacji
 * @param {Array} providers - Lista providerów
 * @param {Object} order - Zlecenie
 * @param {Object} workflow - Workflow configuration
 * @returns {Object} Wybrany provider
 */
function locationBasedStrategy(providers, order, workflow) {
  if (providers.length === 0) return null;
  
  const maxDistance = workflow.routingRules.locationBased.maxDistance || 50;
  const orderLat = order.locationLat || order.location?.coords?.lat;
  const orderLon = order.locationLon || order.location?.coords?.lon;
  
  if (!orderLat || !orderLon) {
    // Brak lokalizacji - fallback do round-robin
    return roundRobinStrategy(providers, workflow);
  }
  
  // Oblicz odległości dla wszystkich providerów
  const providersWithDistance = providers.map(provider => {
    const providerLat = provider.locationCoords?.lat;
    const providerLon = provider.locationCoords?.lng;
    
    if (!providerLat || !providerLon) {
      return { provider, distance: Infinity };
    }
    
    const distance = calculateDistance(orderLat, orderLon, providerLat, providerLon);
    return { provider, distance };
  });
  
  // Filtruj providerów w zasięgu
  const inRange = providersWithDistance.filter(p => p.distance <= maxDistance);
  
  if (inRange.length === 0) {
    // Brak providerów w zasięgu - fallback do round-robin
    return roundRobinStrategy(providers, workflow);
  }
  
  // Sortuj po odległości (najbliżsi pierwsi)
  inRange.sort((a, b) => a.distance - b.distance);
  
  return inRange[0].provider;
}

/**
 * Strategia Service-Based: przypisanie na podstawie przypisań wykonawców do usług/kategorii
 * @param {Array} providers - Lista providerów
 * @param {Object} order - Zlecenie
 * @param {Object} workflow - Workflow configuration
 * @param {Object} company - Company z przypisaniami
 * @returns {Object} Wybrany provider
 */
async function serviceBasedStrategy(providers, order, workflow, company) {
  if (providers.length === 0) return null;
  
  const serviceCode = order.service || order.serviceCode;
  const categoryId = order.category;
  
  if (!serviceCode && !categoryId) {
    // Brak informacji o usłudze/kategorii - fallback do round-robin
    return roundRobinStrategy(providers, workflow);
  }
  
  // Pobierz przypisania wykonawców do usług/kategorii
  const assignments = company.providerServiceAssignments || [];
  
  // Znajdź wykonawców przypisanych do tej usługi/kategorii
  const assignedProviders = assignments
    .filter(assignment => {
      const matchesService = serviceCode && assignment.serviceCodes.includes(serviceCode);
      const matchesCategory = categoryId && assignment.categoryIds.some(id => id.toString() === categoryId.toString());
      return matchesService || matchesCategory;
    })
    .filter(assignment => assignment.autoAssign !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)); // Sortuj po priorytecie
  
  if (assignedProviders.length === 0) {
    // Brak przypisań - fallback do round-robin
    return roundRobinStrategy(providers, workflow);
  }
  
  // Znajdź pierwszego dostępnego wykonawcę z przypisania
  for (const assignment of assignedProviders) {
    const provider = providers.find(p => p._id.toString() === assignment.providerId.toString());
    if (provider) {
      return provider;
    }
  }
  
  // Jeśli żaden przypisany wykonawca nie jest dostępny, fallback do round-robin
  return roundRobinStrategy(providers, workflow);
}

/**
 * Strategia Specialization-Based: przypisanie na podstawie specjalizacji
 * @param {Array} providers - Lista providerów
 * @param {Object} order - Zlecenie
 * @param {Object} workflow - Workflow configuration
 * @returns {Object} Wybrany provider
 */
async function specializationBasedStrategy(providers, order, workflow) {
  if (providers.length === 0) return null;
  
  const orderService = order.service || '';
  const orderCategory = order.serviceCategory || '';
  
  // Pobierz szczegóły usługi jeśli dostępne
  let serviceDetails = null;
  if (orderService) {
    serviceDetails = await Service.findOne({ code: orderService }).lean();
  }
  
  // Oblicz score dla każdego providera
  const providersWithScore = await Promise.all(providers.map(async (provider) => {
    let score = 0;
    
    // Dopasowanie po usługach
    if (workflow.routingRules.specializationBased.matchServices && orderService) {
      const providerServices = provider.services || [];
      const hasService = providerServices.some(s => {
        const serviceId = typeof s === 'object' ? s._id || s : s;
        return serviceId.toString() === orderService;
      });
      
      if (hasService) {
        score += 10;
      } else if (provider.service === orderService) {
        score += 10;
      }
    }
    
    // Dopasowanie po kategoriach
    if (workflow.routingRules.specializationBased.matchCategories && orderCategory) {
      // Sprawdź czy provider ma usługi w tej kategorii
      const providerServices = provider.services || [];
      const hasCategoryMatch = providerServices.some(s => {
        const serviceObj = typeof s === 'object' ? s : { category: s };
        return serviceObj.category === orderCategory || serviceObj.serviceCategory === orderCategory;
      });
      
      if (hasCategoryMatch) {
        score += 5;
      } else if (provider.serviceCategory === orderCategory) {
        score += 5;
      }
    }
    
    return { provider, score };
  }));
  
  // Sortuj po score (najwyższy pierwszy)
  providersWithScore.sort((a, b) => b.score - a.score);
  
  // Jeśli wymagane dokładne dopasowanie, zwróć tylko jeśli score > 0
  if (workflow.routingRules.specializationBased.requireExactMatch) {
    const bestMatch = providersWithScore[0];
    return bestMatch && bestMatch.score > 0 ? bestMatch.provider : null;
  }
  
  return providersWithScore[0]?.provider || null;
}

/**
 * Strategia Availability-Based: przypisanie na podstawie dostępności
 * @param {Array} providers - Lista providerów
 * @param {Object} order - Zlecenie
 * @param {Object} workflow - Workflow configuration
 * @returns {Object} Wybrany provider
 */
function availabilityBasedStrategy(providers, order, workflow) {
  if (providers.length === 0) return null;
  
  const checkOnline = workflow.routingRules.availabilityBased.checkOnlineStatus;
  const preferAvailableNow = workflow.routingRules.availabilityBased.preferAvailableNow;
  
  // Filtruj providerów po dostępności
  let availableProviders = providers;
  
  if (checkOnline) {
    availableProviders = providers.filter(p => {
      const status = p.providerStatus || {};
      return status.isOnline === true;
    });
  }
  
  // Jeśli brak dostępnych, użyj wszystkich
  if (availableProviders.length === 0) {
    availableProviders = providers;
  }
  
  // Jeśli preferujemy dostępnych teraz, zwróć pierwszego dostępnego
  if (preferAvailableNow && availableProviders.length > 0) {
    return availableProviders[0];
  }
  
  // W przeciwnym razie użyj round-robin
  return roundRobinStrategy(availableProviders, workflow);
}

/**
 * Strategia Priority-Based: przypisanie na podstawie priorytetu
 * @param {Array} providers - Lista providerów
 * @param {Object} workflow - Workflow configuration
 * @returns {Object} Wybrany provider
 */
function priorityBasedStrategy(providers, workflow) {
  if (providers.length === 0) return null;
  
  const priorityMembers = workflow.routingRules.priorityBased.priorityMembers || [];
  
  // Mapuj priorytety do providerów
  const providersWithPriority = providers.map(provider => {
    const priorityMember = priorityMembers.find(pm => pm.userId.toString() === provider._id.toString());
    return {
      provider,
      priority: priorityMember?.priority || 0,
      weight: priorityMember?.weight || 1.0
    };
  });
  
  // Sortuj po priorytecie (wyższy pierwszy)
  providersWithPriority.sort((a, b) => b.priority - a.priority);
  
  // Wybierz z najwyższym priorytetem
  const highestPriority = providersWithPriority[0]?.priority || 0;
  const topPriorityProviders = providersWithPriority.filter(p => p.priority === highestPriority);
  
  // Jeśli wielu z tym samym priorytetem, użyj round-robin
  if (topPriorityProviders.length > 1) {
    return roundRobinStrategy(topPriorityProviders.map(p => p.provider), workflow);
  }
  
  return topPriorityProviders[0]?.provider || null;
}

/**
 * Strategia Hybrid: kombinacja wielu strategii
 * @param {Array} providers - Lista providerów
 * @param {Object} order - Zlecenie
 * @param {Object} workflow - Workflow configuration
 * @returns {Object} Wybrany provider
 */
async function hybridStrategy(providers, order, workflow) {
  if (providers.length === 0) return null;
  
  const strategies = workflow.routingRules.hybrid.strategies || [];
  const scoringMethod = workflow.routingRules.hybrid.scoringMethod || 'weighted_sum';
  
  // Oblicz score dla każdego providera używając wszystkich strategii
  const providersWithScores = await Promise.all(providers.map(async (provider) => {
    let totalScore = 0;
    const scores = {};
    
    for (const strategyConfig of strategies) {
      const strategy = strategyConfig.strategy;
      const weight = strategyConfig.weight || 1.0;
      let score = 0;
      
      switch (strategy) {
        case 'round_robin':
          // Round-robin daje równy score wszystkim
          score = 1.0;
          break;
        case 'location_based':
          const locationResult = locationBasedStrategy([provider], order, workflow);
          score = locationResult ? 1.0 : 0.0;
          break;
        case 'specialization_based':
          const specializationResult = await specializationBasedStrategy([provider], order, workflow);
          score = specializationResult ? 1.0 : 0.0;
          break;
        case 'availability_based':
          const availabilityResult = availabilityBasedStrategy([provider], order, workflow);
          score = availabilityResult ? 1.0 : 0.0;
          break;
        case 'priority_based':
          const priorityResult = priorityBasedStrategy([provider], workflow);
          score = priorityResult ? 1.0 : 0.0;
          break;
      }
      
      scores[strategy] = score;
      
      if (scoringMethod === 'weighted_sum') {
        totalScore += score * weight;
      } else if (scoringMethod === 'weighted_product') {
        totalScore = totalScore === 0 ? score * weight : totalScore * (score * weight);
      }
    }
    
    return { provider, totalScore, scores };
  }));
  
  // Sortuj po totalScore (najwyższy pierwszy)
  providersWithScores.sort((a, b) => b.totalScore - a.totalScore);
  
  return providersWithScores[0]?.provider || null;
}

/**
 * Automatycznie przypisuje zlecenie do providera na podstawie reguł workflow
 * @param {String} companyId - ID firmy
 * @param {String} orderId - ID zlecenia
 * @returns {Object} { success: Boolean, provider: User, strategy: String }
 */
async function autoAssignOrder(companyId, orderId) {
  try {
    const workflow = await getOrCreateWorkflow(companyId);
    
    if (!workflow.isAutoAssignEnabled()) {
      return {
        success: false,
        error: 'Automatyczne przypisanie jest wyłączone'
      };
    }
    
    const order = await Order.findById(orderId);
    if (!order) {
      return {
        success: false,
        error: 'Zlecenie nie znalezione'
      };
    }
    
    // Sprawdź czy zlecenie już ma przypisanego providera
    if (order.provider) {
      return {
        success: false,
        error: 'Zlecenie ma już przypisanego providera',
        provider: order.provider
      };
    }
    
    // Pobierz firmę z przypisaniami
    const company = await Company.findById(companyId);
    if (!company) {
      return {
        success: false,
        error: 'Firma nie znaleziona'
      };
    }
    
    // Pobierz kandydatów (członkowie zespołu firmy)
    const providers = await getCompanyProviders(companyId);
    
    if (providers.length === 0) {
      return {
        success: false,
        error: 'Brak dostępnych providerów w zespole'
      };
    }
    
    // Wybierz strategię routingu
    const strategy = workflow.routingRules?.strategy || 'round_robin';
    let selectedProvider = null;
    
    switch (strategy) {
      case 'round_robin':
        selectedProvider = roundRobinStrategy(providers, workflow);
        break;
      case 'location_based':
        selectedProvider = locationBasedStrategy(providers, order, workflow);
        break;
      case 'service_based':
        selectedProvider = await serviceBasedStrategy(providers, order, workflow, company);
        break;
      case 'specialization_based':
        selectedProvider = await specializationBasedStrategy(providers, order, workflow);
        break;
      case 'availability_based':
        selectedProvider = availabilityBasedStrategy(providers, order, workflow);
        break;
      case 'priority_based':
        selectedProvider = priorityBasedStrategy(providers, workflow);
        break;
      case 'hybrid':
        selectedProvider = await hybridStrategy(providers, order, workflow);
        break;
      case 'manual':
        return {
          success: false,
          error: 'Ręczne przypisanie jest włączone',
          requiresManualAssignment: true
        };
      default:
        // Fallback do service_based jeśli są przypisania, w przeciwnym razie round-robin
        if (company.providerServiceAssignments && company.providerServiceAssignments.length > 0) {
          selectedProvider = await serviceBasedStrategy(providers, order, workflow, company);
        } else {
          selectedProvider = roundRobinStrategy(providers, workflow);
        }
    }
    
    if (!selectedProvider) {
      return {
        success: false,
        error: 'Nie znaleziono odpowiedniego providera'
      };
    }
    
    // Przypisz zlecenie do providera
    order.provider = selectedProvider._id;
    order.assignedAt = new Date();
    order.assignedBy = 'workflow_automation';
    await order.save();
    
    // Zaktualizuj statystyki workflow
    workflow.stats.totalAssignments += 1;
    workflow.stats.successfulAssignments += 1;
    workflow.stats.lastAssignmentAt = new Date();
    await workflow.save();
    
    return {
      success: true,
      provider: selectedProvider,
      strategy: strategy
    };
  } catch (error) {
    console.error('Error auto-assigning order:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  getOrCreateWorkflow,
  getCompanyProviders,
  autoAssignOrder,
  roundRobinStrategy,
  locationBasedStrategy,
  specializationBasedStrategy,
  availabilityBasedStrategy,
  priorityBasedStrategy,
  hybridStrategy
};

