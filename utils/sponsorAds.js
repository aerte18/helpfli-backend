const SponsorAd = require('../models/SponsorAd');
const SponsorImpression = require('../models/SponsorImpression');

/**
 * Pobierz liczbę wyświetleń dla reklamy w danym miesiącu
 */
async function getMonthlyImpressions(adId, year, month) {
  try {
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
    
    const count = await SponsorImpression.countDocuments({
      ad: adId,
      type: 'impression',
      createdAt: { $gte: startDate, $lte: endDate }
    });
    
    return count;
  } catch (error) {
    console.error('Error getting monthly impressions:', error);
    return 0;
  }
}

/**
 * Wybierz wariant A/B testu do wyświetlenia
 */
function selectABTestVariant(ad) {
  if (!ad.abTest || !ad.abTest.isActive || !ad.abTest.variants || ad.abTest.variants.length === 0) {
    return null;
  }
  
  // Jeśli jest zwycięzca, użyj go
  if (ad.abTest.winner) {
    return ad.abTest.winner;
  }
  
  // Prosty round-robin lub losowy wybór
  // Można to rozszerzyć o bardziej zaawansowane algorytmy (np. multi-armed bandit)
  const variants = ad.abTest.variants.map(v => v.variant);
  
  // Jeśli jest currentVariant, użyj go (dla spójności)
  if (ad.abTest.currentVariant && variants.includes(ad.abTest.currentVariant)) {
    return ad.abTest.currentVariant;
  }
  
  // Domyślnie pierwszy wariant
  return variants[0] || 'A';
}

/**
 * Sprawdź czy można wybrać zwycięzcę A/B testu i wybierz go jeśli tak
 */
async function checkAndSelectABTestWinner(adId) {
  try {
    const ad = await SponsorAd.findById(adId);
    if (!ad || !ad.abTest || !ad.abTest.isActive || ad.abTest.winner) {
      return;
    }
    
    const totalImpressions = ad.abTest.variants.reduce((sum, v) => sum + (v.stats?.impressions || 0), 0);
    
    // Sprawdź czy osiągnięto minimalną liczbę wyświetleń
    if (totalImpressions < ad.abTest.minImpressions) {
      return; // Za mało danych
    }
    
    // Jeśli autoSelectWinner jest wyłączone, nie wybieraj automatycznie
    if (!ad.abTest.autoSelectWinner) {
      return;
    }
    
    // Znajdź wariant z najlepszym CTR
    let bestVariant = null;
    let bestCTR = -1;
    
    for (const variant of ad.abTest.variants) {
      const ctr = variant.stats?.ctr || 0;
      if (ctr > bestCTR) {
        bestCTR = ctr;
        bestVariant = variant.variant;
      }
    }
    
    // Jeśli znaleziono najlepszy wariant, ustaw go jako zwycięzcę
    if (bestVariant && bestCTR > 0) {
      ad.abTest.winner = bestVariant;
      ad.abTest.currentVariant = bestVariant;
      ad.abTest.isActive = false; // Zakończ test
      await ad.save();
      
      console.log(`[checkAndSelectABTestWinner] Wybrano zwycięzcę A/B testu dla reklamy ${ad.title}: wariant ${bestVariant} (CTR: ${bestCTR.toFixed(2)}%)`);
    }
  } catch (error) {
    console.error('Error checking AB test winner:', error);
  }
}

/**
 * Oblicz odległość między dwoma punktami (Haversine formula)
 * @param {number} lat1 - Szerokość geograficzna punktu 1
 * @param {number} lon1 - Długość geograficzna punktu 1
 * @param {number} lat2 - Szerokość geograficzna punktu 2
 * @param {number} lon2 - Długość geograficzna punktu 2
 * @returns {number} Odległość w kilometrach
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
 * Znajdź odpowiednie reklamy sponsorowane dla danego kontekstu
 * @param {Object} context - Kontekst zapytania AI
 * @param {Array<string>} context.keywords - Słowa kluczowe z zapytania
 * @param {string} context.serviceCategory - Kategoria usługi
 * @param {string} context.orderType - Typ zlecenia
 * @param {Object} context.location - Lokalizacja { city, lat, lon }
 * @param {number} limit - Maksymalna liczba reklam do zwrócenia
 * @returns {Promise<Array>} Lista dopasowanych reklam
 */
async function findRelevantAds(context, limit = 3, displayLocation = null, userId = null) {
  try {
    const { keywords = [], serviceCategory, orderType, location } = context;
    
    // Znajdź aktywne reklamy (normalne + darmowe próby + sezonowe)
    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 1-12
    const isDecember = currentMonth === 12;
    const isJulyAugust = currentMonth === 7 || currentMonth === 8;
    const isMarchMay = currentMonth >= 3 && currentMonth <= 5;
    
    // Znajdź wszystkie aktywne reklamy (filtrowanie po datach zrobimy w kodzie)
    const allActiveAds = await SponsorAd.find({
      status: 'active'
    }).lean();
    
    // Filtruj po datach kampanii/prób/sezonowych w kodzie JavaScript
    const adsWithValidDates = allActiveAds.filter(ad => {
      // Darmowe próby
      if (ad.freeTrial?.isFreeTrial) {
        if (!ad.freeTrial.trialEndDate) return false;
        if (new Date(ad.freeTrial.trialEndDate) < now) return false;
        if (ad.freeTrial.convertedToPackage === true) return false;
        return true;
      }
      
      // Sezonowe pakiety
      if (ad.seasonalPackage?.isSeasonal) {
        const seasonalPeriod = ad.seasonalPackage.seasonalPeriod;
        const matchesPeriod = 
          (seasonalPeriod === 'december' && isDecember) ||
          (seasonalPeriod === 'july-august' && isJulyAugust) ||
          (seasonalPeriod === 'march-may' && isMarchMay);
        
        if (!matchesPeriod) return false;
        if (ad.seasonalPackage.seasonalStartDate && new Date(ad.seasonalPackage.seasonalStartDate) > now) return false;
        if (ad.seasonalPackage.seasonalEndDate && new Date(ad.seasonalPackage.seasonalEndDate) < now) return false;
        return true;
      }
      
      // Normalne reklamy - sprawdź daty kampanii (jeśli istnieją)
      if (ad.campaign?.startDate && ad.campaign?.endDate) {
        if (new Date(ad.campaign.startDate) > now) return false;
        if (new Date(ad.campaign.endDate) < now) return false;
      }
      // Jeśli nie ma dat kampanii, uznaj za aktywną (backward compatibility)
      
      return true;
    });
    
    // Filtruj po budżecie, limitach miesięcznych i pozycji wyświetlania
    // Używamy Promise.all z map, ponieważ musimy użyć await dla getMonthlyImpressions
    const activeAdsPromises = adsWithValidDates.map(async (ad) => {
      // Sprawdź darmową próbę
      if (ad.freeTrial?.isFreeTrial) {
        // Sprawdź czy próba nie wygasła (już sprawdzone w zapytaniu, ale dla pewności)
        if (new Date(ad.freeTrial.trialEndDate) < now) {
          return null;
        }
        
        // Sprawdź limit wyświetleń dla próby
        if (ad.freeTrial.trialImpressionsUsed >= ad.freeTrial.trialImpressionsLimit) {
          return null;
        }
        
        // Próba jest aktywna - nie sprawdzaj budżetu
      } else {
        // Normalna reklama - sprawdź budżet
        const spent = ad.campaign?.spent || 0;
        const budget = ad.campaign?.budget || 0;
        
        if (spent >= budget) {
          console.log(`[findRelevantAds] Reklama ${ad.title} - wyczerpany budżet`);
          return null;
        }
        
        // Sprawdź limit miesięczny (dla pakietów)
        if (ad.campaign?.monthlyLimit && ad.campaign.monthlyLimit > 0) {
          const monthlyImpressions = await getMonthlyImpressions(
            ad._id.toString(), 
            now.getFullYear(), 
            now.getMonth()
          );
          
          if (monthlyImpressions >= ad.campaign.monthlyLimit) {
            console.log(`[findRelevantAds] Reklama ${ad.title} - wyczerpany limit miesięczny (${monthlyImpressions}/${ad.campaign.monthlyLimit})`);
            return null;
          }
        }
      }
      
      // Sprawdź czy reklama ma wybraną pozycję wyświetlania
      if (displayLocation) {
        // Jeśli reklama ma określone displayLocations, sprawdź czy zawiera żądaną pozycję
        if (ad.displayLocations && ad.displayLocations.length > 0) {
          if (!ad.displayLocations.includes(displayLocation)) {
            console.log(`[findRelevantAds] Reklama ${ad.title} - brak pozycji ${displayLocation} (ma: ${ad.displayLocations.join(', ')})`);
            return null; // Reklama nie ma tej pozycji w pakiecie
          }
        }
        // Jeśli reklama nie ma displayLocations (stara reklama), pokazuj wszędzie
      }
      
      return ad;
    });
    
    const activeAdsResults = await Promise.all(activeAdsPromises);
    const activeAds = activeAdsResults.filter(ad => ad !== null);
    
    console.log(`[findRelevantAds] Znaleziono ${activeAds.length} aktywnych reklam`);
    console.log(`[findRelevantAds] Kontekst:`, { keywords, serviceCategory, orderType, location });
    
    // Filtruj po kontekście
    const matchedAds = activeAds
      .filter(ad => {
        // Użyj metody matchesContext bezpośrednio na obiekcie
        return matchesContextHelper(ad, context);
      })
      .map(ad => ({
        ...ad,
        matchScore: calculateMatchScore(ad, context)
      }))
      .sort((a, b) => {
        // Sortuj po: priorytet (wyższy), match score (wyższy), pozostały budżet (wyższy)
        // Dla aukcji: sortuj po currentBid (wyższy)
        if (a.auction?.enabled && b.auction?.enabled) {
          return (b.auction.currentBid || 0) - (a.auction.currentBid || 0);
        }
        if (a.auction?.enabled) return -1; // Aukcje mają priorytet
        if (b.auction?.enabled) return 1;
        
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        
        // Bezpieczne obliczenie pozostałego budżetu (sprawdź czy campaign istnieje)
        const bRemainingBudget = (b.campaign?.budget || 0) - (b.campaign?.spent || 0);
        const aRemainingBudget = (a.campaign?.budget || 0) - (a.campaign?.spent || 0);
        return bRemainingBudget - aRemainingBudget;
      })
      .slice(0, limit);
    
    console.log(`[findRelevantAds] Po filtrowaniu: ${matchedAds.length} reklam`);
    
    // Obsługa A/B Testing - wybierz wariant dla każdej reklamy
    const adsWithVariants = await Promise.all(matchedAds.map(async (ad) => {
      if (ad.abTest?.isActive && ad.abTest.variants && ad.abTest.variants.length > 0) {
        // Wybierz wariant do wyświetlenia
        const selectedVariant = selectABTestVariant(ad);
        
        // Jeśli test się zakończył i mamy zwycięzcę, użyj go
        if (ad.abTest.winner) {
          const winnerVariant = ad.abTest.variants.find(v => v.variant === ad.abTest.winner);
          if (winnerVariant) {
            return {
              ...ad,
              abTestVariant: ad.abTest.winner,
              abTestData: winnerVariant
            };
          }
        }
        
        // Użyj wybranego wariantu
        const variantData = ad.abTest.variants.find(v => v.variant === selectedVariant);
        if (variantData) {
          return {
            ...ad,
            abTestVariant: selectedVariant,
            abTestData: variantData
          };
        }
      }
      
      return ad;
    }));
    
    return adsWithVariants;
  } catch (error) {
    console.error('[findRelevantAds] Error finding relevant ads:', error);
    console.error('[findRelevantAds] Stack:', error.stack);
    console.error('[findRelevantAds] Context:', { context, displayLocation, limit, userId });
    return [];
  }
}

/**
 * Pomocnicza funkcja do sprawdzania dopasowania kontekstu (bez instancji modelu)
 */
function matchesContextHelper(ad, context) {
  const { keywords = [], serviceCategory, orderType, location } = context;
  
  // Sprawdź słowa kluczowe
  if (keywords && keywords.length > 0 && ad.keywords && ad.keywords.length > 0) {
    const matchesKeywords = keywords.some(kw => 
      ad.keywords.some(adKw => 
        kw.toLowerCase().includes(adKw.toLowerCase()) || 
        adKw.toLowerCase().includes(kw.toLowerCase())
      )
    );
    if (!matchesKeywords) return false;
  }
  
  // Sprawdź kategorię usługi
  if (serviceCategory && ad.serviceCategories && ad.serviceCategories.length > 0) {
    if (!ad.serviceCategories.includes(serviceCategory)) return false;
  }
  
  // Sprawdź typ zlecenia
  if (orderType && ad.orderTypes && ad.orderTypes.length > 0) {
    if (!ad.orderTypes.includes(orderType)) return false;
  }
  
  // Sprawdź lokalizację (jeśli określona)
  if (location && ad.geotargeting?.enabled) {
    const geoType = ad.geotargeting.type;
    
    // Country - pokazuj wszędzie w Polsce
    if (geoType === 'country') {
      // Zawsze pasuje
    }
    // Voivodeship - sprawdź województwo
    else if (geoType === 'voivodeship' && location.voivodeship) {
      if (ad.geotargeting.voivodeships && ad.geotargeting.voivodeships.length > 0) {
        if (!ad.geotargeting.voivodeships.includes(location.voivodeship)) {
          return false;
        }
      }
    }
    // City - sprawdź miasto
    else if (geoType === 'city' && location.city) {
      if (ad.geotargeting.cities && ad.geotargeting.cities.length > 0) {
        if (!ad.geotargeting.cities.some(c => c.toLowerCase() === location.city.toLowerCase())) {
          return false;
        }
      }
    }
    // District - sprawdź dzielnicę (Enterprise)
    else if (geoType === 'district' && location.district) {
      if (ad.geotargeting.districts && ad.geotargeting.districts.length > 0) {
        if (!ad.geotargeting.districts.some(d => d.toLowerCase() === location.district.toLowerCase())) {
          return false;
        }
      }
    }
    // Radius - sprawdź odległość (Enterprise)
    else if (geoType === 'radius' && location.lat && location.lon) {
      if (ad.geotargeting.radiusTargets && ad.geotargeting.radiusTargets.length > 0) {
        const matchesRadius = ad.geotargeting.radiusTargets.some(target => {
          const distance = calculateDistance(
            location.lat, location.lon,
            target.lat, target.lon
          );
          return distance <= target.radius;
        });
        if (!matchesRadius) return false;
      }
    }
    
    // Fallback - sprawdź stare pole locations (backward compatibility)
    if (ad.locations && ad.locations.length > 0) {
      const matchesLocation = ad.locations.some(loc => {
        if (loc.city && location.city) {
          return loc.city.toLowerCase() === location.city.toLowerCase();
        }
        if (loc.voivodeship && location.voivodeship) {
          return loc.voivodeship.toLowerCase() === location.voivodeship.toLowerCase();
        }
        if (loc.lat && loc.lon && location.lat && location.lon && loc.radius) {
          const distance = calculateDistance(location.lat, location.lon, loc.lat, loc.lon);
          return distance <= loc.radius;
        }
        return true;
      });
      if (!matchesLocation) return false;
    }
  } else if (location && ad.locations && ad.locations.length > 0) {
    // Backward compatibility - stare pole locations
    const matchesLocation = ad.locations.some(loc => {
      if (loc.city && location.city) {
        return loc.city.toLowerCase() === location.city.toLowerCase();
      }
      return true;
    });
    if (!matchesLocation) return false;
  }
  
  // Jeśli kontekst jest pusty (banner na stronie głównej) - pokazuj wszystkie aktywne reklamy
  const isEmptyContext = (!keywords || keywords.length === 0) && !serviceCategory && !orderType && !location;
  if (isEmptyContext) {
    return true; // Dla bannerów bez kontekstu - pokazuj wszystkie aktywne
  }
  
  // Jeśli kontekst nie jest pusty, ale nie ma dopasowania - zwróć false
  // (już sprawdziliśmy keywords, serviceCategory, orderType, location wyżej)
  
  return true;
}

/**
 * Oblicz wynik dopasowania reklamy do kontekstu
 */
function calculateMatchScore(ad, context) {
  let score = 0;
  const { keywords = [], serviceCategory, orderType } = context;
  
  // Dopasowanie słów kluczowych
  if (keywords.length > 0 && ad.keywords.length > 0) {
    const matchedKeywords = keywords.filter(kw =>
      ad.keywords.some(adKw =>
        kw.toLowerCase().includes(adKw.toLowerCase()) ||
        adKw.toLowerCase().includes(kw.toLowerCase())
      )
    ).length;
    score += (matchedKeywords / Math.max(keywords.length, ad.keywords.length)) * 50;
  }
  
  // Dopasowanie kategorii usługi
  if (serviceCategory && ad.serviceCategories.includes(serviceCategory)) {
    score += 30;
  }
  
  // Dopasowanie typu zlecenia
  if (orderType && ad.orderTypes.includes(orderType)) {
    score += 20;
  }
  
  return score;
}

/**
 * Zarejestruj wyświetlenie reklamy
 */
async function recordImpression(adId, userId, context) {
  try {
    const ad = await SponsorAd.findById(adId);
    if (!ad || !ad.isActive()) return;
    
    // Sprawdź limit darmowej próby
    if (ad.freeTrial?.isFreeTrial) {
      // Sprawdź czy próba nie wygasła
      if (new Date() > new Date(ad.freeTrial.trialEndDate)) {
        // Próba wygasła - dezaktywuj reklamę
        ad.status = 'expired';
        await ad.save();
        return;
      }
      
      // Sprawdź limit wyświetleń dla próby
      if (ad.freeTrial.trialImpressionsUsed >= ad.freeTrial.trialImpressionsLimit) {
        // Limit wyczerpany - dezaktywuj reklamę
        ad.status = 'expired';
        await ad.save();
        return;
      }
    }
    
    // Sprawdź dzienny limit (tylko dla reklam z kampanią)
    if (ad.campaign?.dailyBudget) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayImpressions = await SponsorImpression.countDocuments({
        ad: adId,
        createdAt: { $gte: today },
        type: 'impression'
      });
      
      // Oblicz koszt dzisiejszych wyświetleń
      const todayCost = todayImpressions * (ad.campaign?.pricePerImpression || 0);
      if (todayCost >= ad.campaign.dailyBudget) {
        return; // Przekroczono dzienny budżet
      }
    }
    
    // Sprawdź maksymalną liczbę wyświetleń (tylko dla reklam z kampanią)
    if (ad.campaign?.maxImpressions && ad.stats.impressions >= ad.campaign.maxImpressions) {
      return;
    }
    
    // Sprawdź czy to retargeting (użytkownik widział już tę reklamę)
    let isRetargeting = false;
    let previousImpressionDate = null;
    if (userId) {
      const previousImpression = await SponsorImpression.findOne({
        ad: adId,
        user: userId,
        type: 'impression'
      }).sort({ createdAt: -1 });
      
      if (previousImpression) {
        isRetargeting = true;
        previousImpressionDate = previousImpression.createdAt;
      }
    }
    
    // Zarejestruj wyświetlenie
    const impression = await SponsorImpression.create({
      ad: adId,
      user: userId,
      type: 'impression',
      context: context,
      abTestVariant: context.abTestVariant || null, // Zapisz który wariant został wyświetlony
      isRetargeting: isRetargeting,
      previousImpressionDate: previousImpressionDate
    });
    
    // Zaktualizuj statystyki
    ad.stats.impressions += 1;
    
    // Zaktualizuj statystyki A/B testu jeśli aktywny
    if (ad.abTest?.isActive && context.abTestVariant) {
      const variant = ad.abTest.variants.find(v => v.variant === context.abTestVariant);
      if (variant) {
        variant.stats.impressions = (variant.stats.impressions || 0) + 1;
        variant.stats.ctr = variant.stats.impressions > 0 
          ? ((variant.stats.clicks || 0) / variant.stats.impressions) * 100 
          : 0;
      }
    }
    
    // Zaktualizuj licznik darmowej próby
    if (ad.freeTrial?.isFreeTrial) {
      ad.freeTrial.trialImpressionsUsed += 1;
    }
    
    if (ad.campaign?.pricingModel === 'cpm' && !ad.freeTrial?.isFreeTrial) {
      ad.campaign.spent += ad.campaign.pricePerImpression || 0;
    }
    await ad.save();
    
    // Sprawdź czy można wybrać zwycięzcę A/B testu
    if (ad.abTest?.isActive && !ad.abTest.winner) {
      await checkAndSelectABTestWinner(adId);
    }
    
    return true;
  } catch (error) {
    console.error('Error recording impression:', error);
    return false;
  }
}

/**
 * Zarejestruj kliknięcie w reklamę
 */
async function recordClick(adId, userId, context) {
  try {
    const ad = await SponsorAd.findById(adId);
    if (!ad || !ad.isActive()) return;
    
    // Sprawdź maksymalną liczbę kliknięć (tylko dla reklam z kampanią)
    if (ad.campaign?.maxClicks && ad.stats.clicks >= ad.campaign.maxClicks) {
      return;
    }
    
    // Zarejestruj kliknięcie
    const click = await SponsorImpression.create({
      ad: adId,
      user: userId,
      type: 'click',
      context: context,
      abTestVariant: context.abTestVariant || null // Zapisz który wariant został kliknięty
    });
    
    // Zaktualizuj statystyki
    ad.stats.clicks += 1;
    ad.stats.ctr = ad.stats.impressions > 0 
      ? (ad.stats.clicks / ad.stats.impressions) * 100 
      : 0;
    
    // Zaktualizuj statystyki A/B testu jeśli aktywny
    if (ad.abTest?.isActive && context.abTestVariant) {
      const variant = ad.abTest.variants.find(v => v.variant === context.abTestVariant);
      if (variant) {
        variant.stats.clicks = (variant.stats.clicks || 0) + 1;
        variant.stats.ctr = variant.stats.impressions > 0 
          ? (variant.stats.clicks / variant.stats.impressions) * 100 
          : 0;
        variant.stats.conversionRate = variant.stats.clicks > 0
          ? ((variant.stats.conversions || 0) / variant.stats.clicks) * 100
          : 0;
      }
    }
    
    if (ad.campaign?.pricingModel === 'cpc') {
      ad.campaign.spent += ad.campaign.pricePerClick || 0;
    }
    
    await ad.save();
    
    // Sprawdź czy można wybrać zwycięzcę A/B testu
    if (ad.abTest?.isActive && !ad.abTest.winner) {
      await checkAndSelectABTestWinner(adId);
    }
    
    return true;
  } catch (error) {
    console.error('Error recording click:', error);
    return false;
  }
}

/**
 * Formatuj reklamy dla odpowiedzi AI
 */
function formatAdsForAI(ads) {
  return ads.map(ad => {
    // Jeśli reklama ma A/B test, użyj danych z wybranego wariantu
    let title = ad.title;
    let description = ad.description;
    let imageUrl = ad.imageUrl;
    let ctaText = ad.ctaText;
    
    if (ad.abTestVariant && ad.abTestData) {
      title = ad.abTestData.title || title;
      description = ad.abTestData.description || description;
      imageUrl = ad.abTestData.imageUrl || imageUrl;
      ctaText = ad.abTestData.ctaText || ctaText;
    }
    
    return {
      id: ad._id,
      abTestVariant: ad.abTestVariant || null, // Przekaż informację o wariancie
      type: ad.adType,
      title: title,
      description: description,
      link: ad.link,
      ctaText: ctaText,
      imageUrl: imageUrl,
      logoUrl: ad.logoUrl,
      details: ad.details
    };
  });
}

module.exports = {
  findRelevantAds,
  recordImpression,
  recordClick,
  formatAdsForAI,
  calculateMatchScore
};

