function clamp(num, min, max) { return Math.min(max, Math.max(min, num)); }

function validateRankingConfig(input) {
  const LIMITS = {
    weightSub:       { min: 0, max: 5 },
    weightBoosts:    { min: 0, max: 5 },
    weightRating:    { min: 0, max: 20 },
    weightCompleted: { min: 0, max: 5 },
    thresholdTop:    { min: 0, max: 500 },
  };

  const out = {};
  for (const [k, lim] of Object.entries(LIMITS)) {
    const v = Number(input[k]);
    if (Number.isNaN(v)) throw new Error(`Pole ${k} musi być liczbą.`);
    out[k] = clamp(v, lim.min, lim.max);
  }

  if (out.weightSub + out.weightBoosts + out.weightRating / 10 > 15) {
    out.weightRating = Math.min(out.weightRating, 10);
  }

  return out;
}

module.exports = { validateRankingConfig };




























