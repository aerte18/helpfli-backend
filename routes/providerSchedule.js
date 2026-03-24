const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const ProviderSchedule = require('../models/ProviderSchedule');
const User = require('../models/User');
const router = express.Router();

// GET /api/provider-schedule/me - pobierz harmonogram bieżącego providera
router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }

    let schedule = await ProviderSchedule.findOne({ user: req.user._id }) || 
                   await ProviderSchedule.findOne({ provider: req.user._id }); // Kompatybilność wsteczna
    
    // Jeśli nie ma harmonogramu, stwórz domyślny
    if (!schedule) {
      schedule = await ProviderSchedule.create({
        user: req.user._id,
        useCalendar: false,
        defaultStatus: 'offline',
        schedule: [],
        recurringPatterns: [],
        exceptions: []
      });
    }

    res.json(schedule);
  } catch (err) {
    console.error('GET_PROVIDER_SCHEDULE_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania harmonogramu' });
  }
});

// GET /api/provider-schedule/:providerId - pobierz harmonogram konkretnego providera (publiczne)
router.get('/:providerId', async (req, res) => {
  try {
    const schedule = await ProviderSchedule.findOne({ user: req.params.providerId }) ||
                     await ProviderSchedule.findOne({ provider: req.params.providerId }); // Kompatybilność wsteczna
    
    if (!schedule) {
      // Jeśli nie ma harmonogramu, zwróć domyślny (nie używa kalendarza)
      return res.json({
        useCalendar: false,
        defaultStatus: 'offline',
        schedule: [],
        recurringPatterns: [],
        exceptions: []
      });
    }

    // Zwróć tylko publiczne informacje (bez szczegółów)
    res.json({
      useCalendar: schedule.useCalendar,
      defaultStatus: schedule.defaultStatus,
      schedule: schedule.schedule.map(s => ({
        date: s.date,
        available: s.available
      })),
      recurringPatterns: schedule.recurringPatterns
    });
  } catch (err) {
    console.error('GET_PROVIDER_SCHEDULE_PUBLIC_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania harmonogramu' });
  }
});

// PUT /api/provider-schedule/me - zaktualizuj harmonogram
router.put('/me', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }

    const { useCalendar, defaultStatus, schedule, recurringPatterns, exceptions } = req.body;

    // Walidacja
    if (useCalendar === false && !defaultStatus) {
      return res.status(400).json({ message: 'defaultStatus jest wymagany gdy useCalendar = false' });
    }

    if (useCalendar === true && (!schedule || !Array.isArray(schedule))) {
      return res.status(400).json({ message: 'schedule jest wymagany gdy useCalendar = true' });
    }

    // Zaktualizuj lub stwórz harmonogram
    const query = { $or: [{ user: req.user._id }, { provider: req.user._id }] };
    const updateData = {
      user: req.user._id, // Zawsze ustaw user
      useCalendar: useCalendar ?? false,
      defaultStatus: defaultStatus || 'offline',
      schedule: schedule || [],
      recurringPatterns: recurringPatterns || [],
      exceptions: exceptions || []
    };
    
    const updated = await ProviderSchedule.findOneAndUpdate(
      query,
      updateData,
      { upsert: true, new: true, runValidators: true }
    );

    // Zaktualizuj też provider_status.isOnline jeśli nie używa kalendarza
    if (useCalendar === false) {
      await User.findByIdAndUpdate(req.user._id, {
        'provider_status.isOnline': defaultStatus === 'online'
      });
    }

    res.json(updated);
  } catch (err) {
    console.error('UPDATE_PROVIDER_SCHEDULE_ERROR:', err);
    res.status(500).json({ message: 'Błąd aktualizacji harmonogramu', error: err.message });
  }
});

// Helper: sprawdź czy provider jest dostępny w danym dniu
async function isProviderAvailable(providerId, date) {
  const schedule = await ProviderSchedule.findOne({ 
    $or: [
      { user: providerId },
      { provider: providerId } // Kompatybilność wsteczna
    ]
  });
  
  if (!schedule) {
    // Brak harmonogramu = sprawdź provider_status.isOnline
    const user = await User.findById(providerId).select('provider_status');
    return user?.provider_status?.isOnline || false;
  }

  if (!schedule.useCalendar) {
    // Nie używa kalendarza = sprawdź defaultStatus
    return schedule.defaultStatus === 'online';
  }

  // Używa kalendarza - sprawdź harmonogram
  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);
  const targetDayOfWeek = targetDate.getDay();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDayName = dayNames[targetDayOfWeek];

  // Sprawdź wyjątki
  if (schedule.exceptions && schedule.exceptions.length > 0) {
    const exception = schedule.exceptions.find(e => {
      if (!e.date) return false;
      const exDate = new Date(e.date);
      exDate.setHours(0, 0, 0, 0);
      return exDate.getTime() === targetDate.getTime();
    });
    if (exception) {
      return exception.available;
    }
  }

  // Sprawdź konkretną datę w harmonogramie
  if (schedule.schedule && schedule.schedule.length > 0) {
    const specificDate = schedule.schedule.find(s => {
      if (!s.date) return false;
      const sDate = new Date(s.date);
      sDate.setHours(0, 0, 0, 0);
      return sDate.getTime() === targetDate.getTime();
    });
    if (specificDate) {
      return specificDate.available;
    }
  }

  // Sprawdź wzorce powtarzalne (nowa struktura z days[])
  if (schedule.recurringPatterns && schedule.recurringPatterns.length > 0) {
    for (const pattern of schedule.recurringPatterns) {
      if (!pattern.active) continue;
      
      // Nowa struktura: pattern.days[]
      if (pattern.days && pattern.days.length > 0) {
        const dayPattern = pattern.days.find(d => 
          d.dayOfWeek && d.dayOfWeek.toLowerCase() === targetDayName
        );
        if (dayPattern && dayPattern.available) {
          return true;
        }
      }
      
      // Stara struktura: pattern.dayOfWeek (liczba) - kompatybilność wsteczna
      if (pattern.dayOfWeek !== undefined && pattern.dayOfWeek === targetDayOfWeek) {
        if (pattern.available) {
          return true;
        }
      }
    }
  }

  // Domyślnie niedostępny
  return false;
}

// Helper: sprawdź czy provider jest dostępny TERAZ (z uwzględnieniem czasu)
async function isProviderAvailableNow(providerId) {
  const User = require('../models/User');
  const schedule = await ProviderSchedule.findOne({ 
    $or: [
      { user: providerId },
      { provider: providerId } // Kompatybilność wsteczna
    ]
  });
  
  if (!schedule) {
    // Brak harmonogramu = sprawdź provider_status.isOnline
    const user = await User.findById(providerId).select('provider_status');
    return user?.provider_status?.isOnline || false;
  }

  if (!schedule.useCalendar) {
    // Nie używa kalendarza = sprawdź defaultStatus i isOnline
    const user = await User.findById(providerId).select('provider_status');
    const isOnline = user?.provider_status?.isOnline || false;
    return schedule.defaultStatus === 'online' && isOnline;
  }

  // Używa kalendarza - sprawdź harmonogram dla TERAZ (dzisiaj + aktualna godzina)
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayOfWeek = today.getDay();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[dayOfWeek];

  // Helper: sprawdź czy aktualna godzina mieści się w przedziale czasowym
  const isTimeInSlot = (currentTimeStr, timeSlots) => {
    if (!timeSlots || timeSlots.length === 0) return true; // Brak timeSlots = dostępny cały dzień
    
    return timeSlots.some(slot => {
      const start = slot.startTime || slot.start || '00:00';
      const end = slot.endTime || slot.end || '23:59';
      return currentTimeStr >= start && currentTimeStr <= end;
    });
  };

  // Sprawdź wyjątki
  if (schedule.exceptions && schedule.exceptions.length > 0) {
    const exception = schedule.exceptions.find(e => {
      if (!e.date) return false;
      const exDate = new Date(e.date);
      exDate.setHours(0, 0, 0, 0);
      return exDate.getTime() === today.getTime();
    });
    if (exception) {
      return exception.available && isTimeInSlot(currentTime, exception.timeSlots || []);
    }
  }

  // Sprawdź konkretną datę w harmonogramie
  if (schedule.schedule && schedule.schedule.length > 0) {
    const specificDate = schedule.schedule.find(s => {
      if (!s.date) return false;
      const sDate = new Date(s.date);
      sDate.setHours(0, 0, 0, 0);
      return sDate.getTime() === today.getTime();
    });
    if (specificDate && specificDate.available) {
      return isTimeInSlot(currentTime, specificDate.timeSlots || []);
    }
  }

  // Sprawdź wzorce powtarzalne (nowa struktura z days[])
  if (schedule.recurringPatterns && schedule.recurringPatterns.length > 0) {
    for (const pattern of schedule.recurringPatterns) {
      if (!pattern.active) continue;
      
      // Nowa struktura: pattern.days[]
      if (pattern.days && pattern.days.length > 0) {
        const dayPattern = pattern.days.find(d => 
          d.dayOfWeek && d.dayOfWeek.toLowerCase() === dayName
        );
        if (dayPattern && dayPattern.available) {
          return isTimeInSlot(currentTime, dayPattern.timeSlots || []);
        }
      }
      
      // Stara struktura: pattern.dayOfWeek (liczba) - kompatybilność wsteczna
      if (pattern.dayOfWeek !== undefined && pattern.dayOfWeek === dayOfWeek) {
        if (pattern.available) {
          return isTimeInSlot(currentTime, pattern.timeSlots || []);
        }
      }
    }
  }

  // Domyślnie niedostępny
  return false;
}

// Eksportuj helpery dla użycia w innych modułach
module.exports = router;
module.exports.isProviderAvailable = isProviderAvailable;
module.exports.isProviderAvailableNow = isProviderAvailableNow;

