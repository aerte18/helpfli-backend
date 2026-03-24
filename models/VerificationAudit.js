const mongoose = require("mongoose");

const VerificationAuditSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // admin lub sam użytkownik
  action: { type: String, required: true }, // np. PROFILE_UPDATED, EMAIL_CODE_SENT, EMAIL_VERIFIED, SUBMIT, APPROVE, REJECT, SUSPEND, NOTE
  meta: { type: Object },
}, { timestamps: true });

module.exports = mongoose.model("VerificationAudit", VerificationAuditSchema);

























