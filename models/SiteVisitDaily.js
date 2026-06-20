const mongoose = require('mongoose');

/**
 * Dzienne, zagregowane wejścia (1× na sesję przeglądarki, bez IP, bez userId).
 * Uzupełnia telemetrię page_view — odsłony per nawigacja (wymaga zgody na analitykę).
 */
const siteVisitDailySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    path: { type: String, required: true, default: '/', maxlength: 200 },
    count: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

siteVisitDailySchema.index({ date: 1, path: 1 }, { unique: true });

module.exports =
  mongoose.models.SiteVisitDaily || mongoose.model('SiteVisitDaily', siteVisitDailySchema);
