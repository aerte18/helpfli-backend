const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  filename: String,
  size: Number,
}, { _id: false });

const ReportLogSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['monthly_global','monthly_cities','monthly_services_batch'],
    required: true
  },
  month: { type: String, required: true },
  recipients: { type: [String], default: [] },
  attachments: { type: [AttachmentSchema], default: [] },
  status: { type: String, enum: ['sent','failed'], default: 'sent' },
  error: { type: String, default: '' },

  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  trigger: { type: String, enum: ['cron','manual'], default: 'cron' },
  triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  sentAt: { type: Date, default: Date.now },
}, { timestamps: true });

ReportLogSchema.index({ type: 1, month: 1, createdAt: -1 });

module.exports = mongoose.model('ReportLog', ReportLogSchema);






















