const ReportLog = require('../models/reportLog');

async function recordReportLog({
  type, month, recipients = [], attachments = [], status = 'sent', error = '',
  settings = {}, trigger = 'cron', triggeredBy = null
}) {
  const attMeta = attachments.map(a => ({
    filename: a.filename || a.name || 'file',
    size: typeof a.size === 'number' ? a.size : (a.content ? (a.content.length || 0) : 0)
  }));
  return await ReportLog.create({
    type, month, recipients, attachments: attMeta, status, error,
    settings, trigger, triggeredBy, sentAt: new Date()
  });
}

module.exports = { recordReportLog };






















