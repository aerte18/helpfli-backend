const ConfigAudit = require('../models/ConfigAudit');

function diffObjects(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const d = {};
  keys.forEach(k => {
    const b = before?.[k];
    const a = after?.[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) d[k] = { before: b, after: a };
  });
  return d;
}

async function writeConfigAudit({ key, userId, before, after, ip, userAgent }) {
  const diff = diffObjects(before, after);
  return await ConfigAudit.create({ key, user: userId, before, after, diff, ip, userAgent });
}

module.exports = { writeConfigAudit, diffObjects };






