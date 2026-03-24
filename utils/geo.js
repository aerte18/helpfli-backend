/**
 * Geo utilities for location-based search and distance calculations
 */

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

/**
 * MVP: Estimate ETA (Estimated Time of Arrival) in minutes
 * v1: Fixed ranges per level
 * v2: Based on distance + level
 * @param {string} level - Provider level: 'basic' | 'standard' | 'pro'
 * @param {number} distanceKm - Distance in kilometers (optional)
 * @returns {{min: number, max: number}} ETA range in minutes
 */
function estimateETA(level, distanceKm = null) {
  // v1: Fixed ranges per level
  const baseETA = {
    pro: { min: 20, max: 40 },
    standard: { min: 30, max: 60 },
    basic: { min: 45, max: 90 }
  };
  
  if (!distanceKm) {
    return baseETA[level] || baseETA.basic;
  }
  
  // v2: Adjust based on distance
  // Assume average speed: 50 km/h in city
  const travelTimeMinutes = Math.round((distanceKm / 50) * 60);
  
  const base = baseETA[level] || baseETA.basic;
  return {
    min: Math.max(base.min, travelTimeMinutes),
    max: Math.max(base.max, travelTimeMinutes + 20)
  };
}

/**
 * Create MongoDB geo query for providers within radius
 * @param {number} lat - Center latitude
 * @param {number} lng - Center longitude
 * @param {number} radiusKm - Radius in kilometers
 * @returns {object} MongoDB query for geo search
 */
function createGeoQuery(lat, lng, radiusKm = 50) {
  // Convert km to radians (1 km ≈ 0.00872665 radians at equator)
  const radiusRadians = radiusKm / 6371;
  
  return {
    location: {
      $geoWithin: {
        $centerSphere: [[lng, lat], radiusRadians]
      }
    }
  };
}

module.exports = {
  calculateDistance,
  estimateETA,
  createGeoQuery
};

