const mongoose = require('mongoose');

const VideoSessionSchema = new mongoose.Schema({
  // Uczestnicy (dla sesji 1:1)
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false }, // Opcjonalne dla grupowych
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Uczestnicy grupowi (dla webinariów, szkoleń)
  participants: [{ 
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true },
    role: { type: String, enum: ['participant', 'moderator', 'host'], default: 'participant' },
    joinedAt: { type: Date, default: null },
    leftAt: { type: Date, default: null }
  }],
  isGroup: { type: Boolean, default: false }, // Czy to sesja grupowa
  maxParticipants: { type: Number, default: 2 }, // Maksymalna liczba uczestników (domyślnie 2 dla 1:1)
  
  // Powiązane zlecenie (opcjonalne)
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  
  // Daily.co room
  dailyRoomId: { type: String, required: true, unique: true },
  dailyRoomName: { type: String, required: true },
  dailyRoomUrl: { type: String, required: true },
  
  // Tokeny dla uczestników (dla sesji 1:1 - kompatybilność wsteczna)
  clientToken: { type: String, required: false }, // Opcjonalne dla grupowych
  providerToken: { type: String, required: false }, // Opcjonalne dla grupowych
  
  // Status sesji
  status: { 
    type: String, 
    enum: ['scheduled', 'active', 'ended', 'cancelled'], 
    default: 'scheduled' 
  },
  
  // Czas
  scheduledAt: { type: Date, default: Date.now },
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  duration: { type: Number, default: 0 }, // w sekundach
  
  // Płatność
  price: { type: Number, default: 0 }, // w groszach
  paid: { type: Boolean, default: false },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  
  // Opcjonalne
  recordingUrl: { type: String, default: null }, // URL nagrania jeśli dostępne
  notes: { type: String, default: '' }, // Notatki z sesji
  
  // Metadata
  metadata: { type: Object, default: {} }
}, { timestamps: true });

// Indeksy
VideoSessionSchema.index({ client: 1, status: 1 });
VideoSessionSchema.index({ provider: 1, status: 1 });
VideoSessionSchema.index({ dailyRoomId: 1 });
VideoSessionSchema.index({ scheduledAt: 1 });

module.exports = mongoose.model('VideoSession', VideoSessionSchema);













