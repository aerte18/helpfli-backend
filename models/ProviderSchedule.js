// Harmonogram dostępności providera
const mongoose = require('mongoose');

const providerScheduleSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: false, // Będzie ustawiane automatycznie
    unique: true, // Jeden harmonogram na providera
    sparse: true // Pozwala na null dla kompatybilności
  },
  // Stare pole dla kompatybilności wstecznej
  provider: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: false
  },
  
  // Czy provider korzysta z kalendarza (jeśli false, używa tylko online/offline)
  useCalendar: { 
    type: Boolean, 
    default: false 
  },
  
  // Domyślny status gdy nie korzysta z kalendarza
  defaultStatus: {
    type: String,
    enum: ['online', 'offline'],
    default: 'offline'
  },
  
  // Harmonogram na konkretne dni (tylko gdy useCalendar = true)
  schedule: [{
    date: { type: Date, required: true }, // Data (bez czasu, tylko dzień)
    available: { type: Boolean, default: true }, // Czy dostępny w tym dniu
    timeSlots: [{ // Opcjonalne przedziały czasowe
      startTime: { type: String }, // Format "HH:mm" (alias dla start)
      endTime: { type: String },   // Format "HH:mm" (alias dla end)
      start: { type: String },      // Format "HH:mm" (dla kompatybilności)
      end: { type: String }         // Format "HH:mm" (dla kompatybilności)
    }]
  }],
  
  // Powtarzalne wzorce (np. "poniedziałek 9-17")
  recurringPatterns: [{
    name: { type: String }, // Nazwa wzorca (np. "Standardowe godziny")
    active: { type: Boolean, default: true }, // Czy wzorzec jest aktywny
    days: [{ // Dni tygodnia w tym wzorcu
      dayOfWeek: { type: String }, // "monday", "tuesday", etc.
      available: { type: Boolean, default: true },
      timeSlots: [{
        startTime: { type: String }, // Format "HH:mm"
        endTime: { type: String }   // Format "HH:mm"
      }]
    }],
    // Stare pola dla kompatybilności (deprecated)
    dayOfWeek: { type: Number }, // 0 = niedziela, 6 = sobota
    timeSlots: [{
      start: { type: String },
      end: { type: String }
    }]
  }],
  
  // Wyjątki od wzorców (np. święta)
  exceptions: [{
    date: { type: Date, required: true },
    available: { type: Boolean, default: false },
    reason: { type: String } // Opcjonalny powód
  }]
}, {
  timestamps: true
});

// Indexy
providerScheduleSchema.index({ user: 1 });
providerScheduleSchema.index({ provider: 1 }); // Kompatybilność wsteczna
providerScheduleSchema.index({ 'schedule.date': 1 });
providerScheduleSchema.index({ 'exceptions.date': 1 });

module.exports = mongoose.models.ProviderSchedule || mongoose.model('ProviderSchedule', providerScheduleSchema);

