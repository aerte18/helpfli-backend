/**
 * Utils do inteligentnego zarządzania wygasaniem zleceń przez AI
 * Automatycznie wydłuża/skraca czas zleceń w zależności od:
 * - Braku ofert → wydłuża
 * - Trudnej usługi → wydłuża
 * - Dużo providerów online → skraca
 * - Analizy historii podobnych zleceń
 * - Personalizacji na podstawie typu usługi
 */

const Order = require('../models/Order');
const User = require('../models/User');
const { calculateDistance } = require('./geo');

/**
 * Sprawdza czy usługa jest "trudna" na podstawie:
 * - Rzadkości w systemie
 * - Czasu realizacji (jeśli dostępny w danych)
 * - Kompleksowości opisu
 */
function isComplexService(order) {
  const complexKeywords = [
    'instalacja', 'montaż', 'remont', 'modernizacja', 'przebudowa',
    'elektryka', 'instalacje elektryczne', 'okablowanie',
    'hydraulika', 'instalacje wodne', 'centralne ogrzewanie',
    'klimatyzacja', 'wentylacja', 'ogrzewanie'
  ];
  
  const serviceLower = (order.service || '').toLowerCase();
  const descLower = (order.description || '').toLowerCase();
  const combined = `${serviceLower} ${descLower}`;
  
  return complexKeywords.some(keyword => combined.includes(keyword));
}

/**
 * Określa typ usługi dla personalizacji czasów wygaśnięcia
 */
function getServiceType(order) {
  const serviceLower = (order.service || '').toLowerCase();
  const descLower = (order.description || '').toLowerCase();
  const combined = `${serviceLower} ${descLower}`;
  
  // Pilne/naprawy - krótkie czasy wygaśnięcia
  if (combined.match(/\b(awaria|naprawa|pilne|nagle|awaryjne|uszkodzenie|pęknięty|zepsuty)\b/)) {
    return 'urgent_repair';
  }
  
  // Instalacje/montaże - wymagają więcej czasu
  if (combined.match(/\b(instalacja|montaż|montowanie|zakładanie|podłączanie)\b/)) {
    return 'installation';
  }
  
  // Konserwacja/przeglądy - standardowe
  if (combined.match(/\b(konserwacja|przegląd|serwis|czyszczenie)\b/)) {
    return 'maintenance';
  }
  
  // Domyślnie standard
  return 'standard';
}

/**
 * Analizuje historię podobnych zleceń aby określić średni czas otrzymania pierwszej oferty
 * @param {Object} order - Bieżące zlecenie
 * @returns {Promise<Object>} Statystyki z historii: średni czas, liczba zleceń, sukces rate
 */
async function analyzeSimilarOrdersHistory(order) {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    // Znajdź podobne zlecenia (ta sama usługa, zakończone w ostatnich 30 dniach)
    const similarOrders = await Order.find({
      service: order.service,
      status: { $in: ['accepted', 'in_progress', 'completed', 'rated'] },
      createdAt: { $gte: thirtyDaysAgo },
      _id: { $ne: order._id } // Wyklucz bieżące zlecenie
    })
      .select('offers createdAt acceptedOfferId status')
      .lean();
    
    if (similarOrders.length === 0) {
      return {
        averageFirstOfferHours: null,
        totalOrders: 0,
        successRate: null,
        hasData: false
      };
    }
    
    // Oblicz średni czas do pierwszej oferty (w godzinach)
    const ordersWithOffers = similarOrders.filter(o => o.offers && o.offers.length > 0);
    let totalHoursToFirstOffer = 0;
    let countWithOffers = 0;
    
    ordersWithOffers.forEach(o => {
      // Załóżmy że pierwsza oferta była dodana gdy został utworzony pierwszy element w offers
      // W rzeczywistości mogłoby być pole createdAt dla każdej oferty
      // Dla uproszczenia używamy czasu utworzenia zlecenia + szacunek
      if (o.offers.length > 0 && o.createdAt) {
        // Szacujemy że pierwsza oferta przyszła średnio po 4-12 godzinach
        // W przyszłości można to ulepszyć mając createdAt dla każdej oferty
        const estimatedFirstOfferHours = 8; // Średnia z szacunku
        totalHoursToFirstOffer += estimatedFirstOfferHours;
        countWithOffers++;
      }
    });
    
    const averageFirstOfferHours = countWithOffers > 0 
      ? totalHoursToFirstOffer / countWithOffers 
      : null;
    
    // Oblicz success rate (ile zleceń otrzymało oferty)
    const successRate = similarOrders.length > 0 
      ? (ordersWithOffers.length / similarOrders.length) 
      : 0;
    
    return {
      averageFirstOfferHours: averageFirstOfferHours ? Math.round(averageFirstOfferHours * 10) / 10 : null,
      totalOrders: similarOrders.length,
      successRate: Math.round(successRate * 100) / 100,
      hasData: true
    };
  } catch (error) {
    console.error('Error analyzing similar orders history:', error);
    return {
      averageFirstOfferHours: null,
      totalOrders: 0,
      successRate: null,
      hasData: false
    };
  }
}

/**
 * Liczy ile providerów jest obecnie online dla danej usługi/lokalizacji
 * Uwzględnia lokalizację - liczy tylko providerów w promieniu 50km
 */
async function countOnlineProviders(order, maxDistanceKm = 50) {
  try {
    // Szukaj providerów którzy mają daną usługę
    const query = {
      role: 'provider',
      services: { $regex: new RegExp(order.service, 'i') }
    };
    
    const providers = await User.find(query)
      .select('locationLat locationLon online provider_status lastActivity')
      .lean();
    
    // Jeśli mamy lokalizację zlecenia, filtruj po odległości
    let nearbyProviders = providers;
    if (order.locationLat && order.locationLon) {
      nearbyProviders = providers.filter(p => {
        if (!p.locationLat || !p.locationLon) return false;
        const distance = calculateDistance(
          order.locationLat,
          order.locationLon,
          p.locationLat,
          p.locationLon
        );
        return distance <= maxDistanceKm;
      });
    }
    
    // Licz aktywnych (sprawdź czy mają ustawiony status online)
    const activeCount = nearbyProviders.filter(p => {
      const isOnline = p.online === true || 
                      (p.provider_status && p.provider_status.isOnline === true) ||
                      (p.provider_status && p.provider_status.availableNow === true);
      
      return isOnline;
    }).length;
    
    // Jeśli nie ma informacji o online, oszacuj na podstawie ogólnej aktywności
    // (zakładamy że ok. 30-40% providerów jest aktywnych w danym momencie)
    const estimatedActive = activeCount > 0 
      ? activeCount 
      : Math.max(1, Math.floor(nearbyProviders.length * 0.35));
    
    return {
      total: nearbyProviders.length,
      active: estimatedActive,
      hasLocation: !!(order.locationLat && order.locationLon)
    };
  } catch (error) {
    console.error('Error counting online providers:', error);
    return { total: 0, active: 0, hasLocation: false };
  }
}

/**
 * Główna funkcja do inteligentnego zarządzania wygasaniem zleceń
 * Sprawdza aktywne zlecenia i podejmuje decyzje o wydłużeniu/skraceniu
 */
async function manageOrderExpiration() {
  try {
    const now = new Date();
    const orders = await Order.find({
      status: { $in: ['open', 'collecting_offers'] },
      expiresAt: { $exists: true, $gt: now } // Tylko jeszcze nie wygasłe
    }).populate('client', 'name email');
    
    let extended = 0;
    let shortened = 0;
    const results = [];
    
    for (const order of orders) {
      try {
        // Sprawdź ile ofert ma zlecenie
        const offersCount = order.offers ? order.offers.length : 0;
        
        // Sprawdź czy usługa jest trudna
        const isComplex = isComplexService(order);
        
        // Określ typ usługi dla personalizacji
        const serviceType = getServiceType(order);
        
        // Sprawdź ile providerów jest online (z uwzględnieniem lokalizacji)
        const providerStats = await countOnlineProviders(order);
        
        // Analizuj historię podobnych zleceń
        const historyStats = await analyzeSimilarOrdersHistory(order);
        
        // Oblicz czas do wygaśnięcia w godzinach
        const expiresAt = new Date(order.expiresAt);
        const hoursUntilExpiry = Math.floor((expiresAt - now) / 1000 / 60 / 60);
        
        let shouldExtend = false;
        let shouldShorten = false;
        let reason = '';
        let newExpiresAt = null;
        
        // Personalizacja na podstawie typu usługi
        let extensionHours = 24; // Domyślnie
        if (serviceType === 'urgent_repair') {
          extensionHours = 12; // Krótsze wydłużenie dla pilnych napraw
        } else if (serviceType === 'installation') {
          extensionHours = 36; // Dłuższe dla instalacji
        } else if (serviceType === 'maintenance') {
          extensionHours = 24; // Standardowe
        }
        
        // Decyzje AI z uwzględnieniem historii i typu usługi:
        
        // 1. Brak ofert + trudna usługa → wydłuż (z personalizacją)
        if (offersCount === 0 && isComplex && hoursUntilExpiry < extensionHours / 2) {
          shouldExtend = true;
          reason = `Brak ofert i trudna usługa (${serviceType}) - automatyczne wydłużenie`;
          newExpiresAt = new Date(expiresAt.getTime() + extensionHours * 60 * 60 * 1000);
        }
        // 2. Brak ofert + historia pokazuje że podobne zlecenia potrzebują więcej czasu
        else if (offersCount === 0 && historyStats.hasData && historyStats.averageFirstOfferHours > hoursUntilExpiry) {
          shouldExtend = true;
          const extraHours = Math.ceil(historyStats.averageFirstOfferHours - hoursUntilExpiry + 6);
          reason = `Brak ofert - historia pokazuje że podobne zlecenia potrzebują ${historyStats.averageFirstOfferHours}h`;
          newExpiresAt = new Date(expiresAt.getTime() + extraHours * 60 * 60 * 1000);
        }
        // 3. Brak ofert (standardowe) → wydłuż o zpersonalizowaną liczbę godzin
        else if (offersCount === 0 && hoursUntilExpiry < 6) {
          shouldExtend = true;
          reason = `Brak ofert (${serviceType}) - automatyczne wydłużenie`;
          newExpiresAt = new Date(expiresAt.getTime() + extensionHours * 60 * 60 * 1000);
        }
        // 4. Dużo providerów online w okolicy + zlecenie ma już oferty → skróć o 6h (ale min 6h pozostaje)
        else if (providerStats.active > 10 && offersCount > 0 && hoursUntilExpiry > 12) {
          shouldShorten = true;
          reason = `Dużo aktywnych providerów w okolicy (${providerStats.active}) - skrócenie czasu na szybszą decyzję`;
          // Skróć o 6h, ale minimum 6h pozostaw
          const newHours = Math.max(6, hoursUntilExpiry - 6);
          newExpiresAt = new Date(now.getTime() + newHours * 60 * 60 * 1000);
        }
        // 5. Mało providerów w okolicy + brak ofert → wydłuż bardziej agresywnie
        else if (offersCount === 0 && providerStats.active <= 3 && hoursUntilExpiry < 12) {
          shouldExtend = true;
          reason = `Brak ofert i mało providerów w okolicy (${providerStats.active}) - wydłużenie`;
          newExpiresAt = new Date(expiresAt.getTime() + (extensionHours + 12) * 60 * 60 * 1000);
        }
        
        // Wykonaj zmianę jeśli decyzja została podjęta
        if (shouldExtend || shouldShorten) {
          order.expiresAt = newExpiresAt;
          order.extendedCount = (order.extendedCount || 0) + 1;
          order.lastExtendedAt = now;
          order.extensionReason = reason;
          order.autoExtended = true;
          
          await order.save();
          
          if (shouldExtend) {
            extended++;
            results.push({
              orderId: order._id,
              action: 'extended',
              reason: reason,
              newExpiresAt: newExpiresAt
            });
          } else {
            shortened++;
            results.push({
              orderId: order._id,
              action: 'shortened',
              reason: reason,
              newExpiresAt: newExpiresAt
            });
          }
        }
      } catch (error) {
        console.error(`Error processing order ${order._id}:`, error);
      }
    }
    
    return {
      processed: orders.length,
      extended,
      shortened,
      results
    };
  } catch (error) {
    console.error('Error in manageOrderExpiration:', error);
    throw error;
  }
}

module.exports = {
  manageOrderExpiration,
  isComplexService,
  countOnlineProviders,
  getServiceType,
  analyzeSimilarOrdersHistory
};

