const mongoose = require("mongoose");

const ReportSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // zgłaszający
  reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  reason: { type: String, required: true },
  status: { type: String, enum: ['pending', 'reviewed', 'dismissed', 'actioned'], default: 'pending', index: true },
  attachments: [{
    filename: { type: String, required: true },
    url: { type: String, required: true }, // /uploads/reports/filename.ext
    mimetype: { type: String },
    size: { type: Number },
    uploadedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// Jedno konto może utworzyć tylko jedno aktywne zgłoszenie danego użytkownika.
ReportSchema.index({ user: 1, reportedUser: 1 }, { unique: true });

module.exports = mongoose.model("Report", ReportSchema);

























