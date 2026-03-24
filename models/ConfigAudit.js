const mongoose = require('mongoose');

const ConfigAuditSchema = new mongoose.Schema({
	key: { type: String, index: true },
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
	before: { type: mongoose.Schema.Types.Mixed, default: {} },
	after: { type: mongoose.Schema.Types.Mixed, default: {} },
	diff: { type: mongoose.Schema.Types.Mixed, default: {} },
	ip: { type: String, default: '' },
	userAgent: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('ConfigAudit', ConfigAuditSchema);




























