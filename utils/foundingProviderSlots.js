const PlatformCounter = require('../models/PlatformCounter');
const User = require('../models/User');

const COUNTER_ID = 'founding_provider';

async function ensureFoundingCounterSynced(limit) {
  let doc = await PlatformCounter.findById(COUNTER_ID).lean();
  if (!doc) {
    const used = await User.countDocuments({ foundingProviderEverActivated: true });
    doc = await PlatformCounter.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $setOnInsert: { used: Math.min(used, limit) } },
      { upsert: true, new: true }
    ).lean();
  }
  return doc;
}

/**
 * Atomowa rezerwacja slotu Founding Provider (max `limit` ever activated).
 * @returns {Promise<boolean>}
 */
async function reserveFoundingProviderSlot(limit) {
  await ensureFoundingCounterSynced(limit);
  const reserved = await PlatformCounter.findOneAndUpdate(
    { _id: COUNTER_ID, used: { $lt: limit } },
    { $inc: { used: 1 } },
    { new: true }
  );
  return !!reserved;
}

async function releaseFoundingProviderSlot() {
  await PlatformCounter.findOneAndUpdate(
    { _id: COUNTER_ID, used: { $gt: 0 } },
    { $inc: { used: -1 } }
  );
}

module.exports = {
  COUNTER_ID,
  reserveFoundingProviderSlot,
  releaseFoundingProviderSlot,
  ensureFoundingCounterSynced,
};
