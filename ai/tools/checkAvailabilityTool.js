/**
 * Tool: checkAvailability
 * Sprawdza dostępność wykonawcy dla określonego terminu
 */

const User = require('../../models/User');
// ProviderSchedule może nie istnieć - użyj fallback
let ProviderSchedule = null;
try {
  ProviderSchedule = require('../../models/ProviderSchedule');
} catch (e) {
  console.warn('ProviderSchedule model not found, using fallback');
}

async function checkAvailabilityTool(params, context) {
  try {
    const { providerId, date, timeSlot = null } = params;

    if (!providerId || !date) {
      throw new Error('providerId and date are required');
    }

    // Sprawdź czy provider istnieje
    const provider = await User.findById(providerId).lean();
    if (!provider || provider.role !== 'provider') {
      throw new Error('Provider not found');
    }

    // Sprawdź dostępność w ProviderSchedule (jeśli model istnieje)
    let schedule = null;
    if (ProviderSchedule) {
      try {
        const targetDate = new Date(date);
        schedule = await ProviderSchedule.findOne({
          userId: providerId,
          date: {
            $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
            $lt: new Date(targetDate.setHours(23, 59, 59, 999))
          }
        }).lean();
      } catch (err) {
        console.warn('Could not check ProviderSchedule:', err.message);
      }
    }

    // Sprawdź status online/offline
    const isOnline = provider.provider_status?.isOnline || false;

    let isAvailable = false;
    let availableSlots = [];

    if (schedule) {
      // Jeśli jest schedule, sprawdź dostępne sloty
      isAvailable = schedule.available || false;
      availableSlots = schedule.availableSlots || [];
    } else {
      // Jeśli nie ma schedule, sprawdź status online
      isAvailable = isOnline;
      // Domyślne sloty
      if (isAvailable) {
        availableSlots = ['morning', 'afternoon', 'evening'];
      }
    }

    // Jeśli podano timeSlot, sprawdź czy jest dostępny
    if (timeSlot && availableSlots.length > 0) {
      isAvailable = availableSlots.includes(timeSlot);
    }

    return {
      success: true,
      providerId: providerId.toString(),
      date: date,
      isAvailable,
      availableSlots,
      isOnline,
      message: isAvailable 
        ? `Wykonawca jest dostępny w dniu ${date}` 
        : `Wykonawca nie jest dostępny w dniu ${date}`
    };

  } catch (error) {
    console.error('checkAvailabilityTool error:', error);
    throw new Error(`Failed to check availability: ${error.message}`);
  }
}

module.exports = checkAvailabilityTool;

