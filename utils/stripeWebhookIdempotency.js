function stripeSourceDate(source, event, fallback = new Date()) {
  const seconds = Number(source?.created ?? event?.created);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date(fallback);
}

function stripeEffectKey(kind, sourceId) {
  const normalizedKind = String(kind || '').trim();
  const normalizedSourceId = String(sourceId || '').trim();
  if (!normalizedKind || !normalizedSourceId) {
    throw new Error('Stripe effect kind and source id are required');
  }
  return `${normalizedKind}:${normalizedSourceId}`;
}

function mergeEffectMarker(update, effectKey, markerPath = 'stripeAppliedEffects') {
  const next = { ...(update || {}) };
  const addToSet = { ...(next.$addToSet || {}) };

  if (addToSet[markerPath] && addToSet[markerPath] !== effectKey) {
    throw new Error(`Conflicting ${markerPath} update`);
  }
  addToSet[markerPath] = effectKey;
  next.$addToSet = addToSet;
  return next;
}

/**
 * Atomically applies an additive/set-once business effect and records the
 * Stripe business key on the same target document. This protects against a
 * retry delivered under a different Stripe event id and against concurrent
 * webhook workers.
 */
async function applyStripeEffectOnce(
  Model,
  targetFilter,
  effectKey,
  update,
  options = {}
) {
  const markerPath = options.markerPath || 'stripeAppliedEffects';
  const filter = {
    ...(targetFilter || {}),
    [markerPath]: { $ne: effectKey },
  };
  const result = await Model.updateOne(
    filter,
    mergeEffectMarker(update, effectKey, markerPath),
    options.updateOptions || undefined
  );
  const modifiedCount = result?.modifiedCount ?? result?.nModified ?? 0;
  const upsertedCount = result?.upsertedCount ?? (result?.upsertedId ? 1 : 0);
  return modifiedCount > 0 || upsertedCount > 0;
}

module.exports = {
  stripeSourceDate,
  stripeEffectKey,
  mergeEffectMarker,
  applyStripeEffectOnce,
};
