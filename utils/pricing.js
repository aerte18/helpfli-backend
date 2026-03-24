// utils/pricing.js
const mongoose = require("mongoose");
const Order = require("../models/Order");

function percentile(arr, p) {
  if (!arr?.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const h = idx - lo;
  return Math.round(sorted[lo] * (1 - h) + sorted[hi] * h);
}

const DEFAULT_BANDS = {
  hydraulik_naprawa: { min: 120, med: 180, max: 300 },
  elektryk_naprawa: { min: 130, med: 200, max: 320 },
  agd_pralka: { min: 150, med: 220, max: 350 },
  ogrzewanie_serwis: { min: 180, med: 260, max: 420 },
  inne: { min: 100, med: 160, max: 280 },
};

function contextAdjust(base, { urgency = "normal", now = new Date() } = {}) {
  let k = 1;
  if (urgency === "today") k *= 1.08;
  if (urgency === "now") k *= 1.2;

  const hour = now.getHours();
  const isNight = hour < 6 || hour >= 21;
  const isWeekend = [0, 6].includes(now.getDay());
  if (isNight) k *= 1.12;
  if (isWeekend) k *= 1.06;

  return {
    min: Math.round((base.min ?? 0) * k),
    p25: base.p25 ? Math.round(base.p25 * k) : undefined,
    med: Math.round((base.med ?? 0) * k),
    p75: base.p75 ? Math.round(base.p75 * k) : undefined,
    max: Math.round((base.max ?? 0) * k),
    k,
  };
}

async function computePricingBands(params = {}) {
  const {
    service = "inne",
    city = null,
    lat = null,
    lng = null,
    urgency = "normal",
    kmRadius = 30,
  } = params;

  // match only completed-like statuses
  const match = {
    service,
    status: { $in: ["completed", "done", "closed"] },
    createdAt: { $gte: new Date(Date.now() - 180 * 24 * 3600 * 1000) },
  };

  const pipeline = [{ $match: match }];

  // Our schema does not store geo point; if you later add it, you can extend here
  if (city) {
    pipeline.unshift({ $match: { location: { $regex: city, $options: "i" } } });
  }

  // choose amount from known fields: pricing.total first, then pricing.baseAmount
  pipeline.push({
    $project: {
      amount: {
        $ifNull: ["$pricing.total", "$pricing.baseAmount"],
      },
    },
  });

  pipeline.push({ $match: { amount: { $gt: 0, $lt: 100000 } } });

  pipeline.push({
    $group: {
      _id: null,
      amounts: { $push: "$amount" },
      count: { $sum: 1 },
    },
  });

  const agg = await Order.aggregate(pipeline).allowDiskUse(true);
  let local = null;
  if (agg?.[0]?.count >= 6) {
    const arr = agg[0].amounts;
    local = {
      count: agg[0].count,
      min: Math.min(...arr),
      p25: percentile(arr, 0.25),
      med: percentile(arr, 0.5),
      p75: percentile(arr, 0.75),
      max: Math.max(...arr),
    };
  }

  const base = local || {
    count: 0,
    ...(DEFAULT_BANDS[service] || DEFAULT_BANDS.inne),
  };

  const withQuartiles = {
    min: base.min ?? Math.round(base.med * 0.6),
    p25: base.p25 ?? Math.round(base.med * 0.85),
    med: base.med,
    p75: base.p75 ?? Math.round(base.med * 1.15),
    max: base.max ?? Math.round(base.med * 1.5),
  };

  const adjusted = contextAdjust(withQuartiles, { urgency });

  return {
    service,
    city,
    lat,
    lng,
    urgency,
    stats: {
      sample: base.count ?? 0,
      raw: withQuartiles,
      adjusted,
    },
    recommended: {
      min: adjusted.p25 ?? adjusted.min,
      max: adjusted.p75 ?? adjusted.max,
      midpoint: Math.round(
        ((adjusted.p25 ?? adjusted.min) + (adjusted.p75 ?? adjusted.max)) / 2
      ),
    },
  };
}

async function priceHintsFromHistory({ serviceCode, cityLike, days = 365 }) {
  const Service = require('../models/Service');
  
  const match = {
    status: { $in: ['completed','closed','paid','finished'] },
    amountTotal: { $gt: 0 }
  };
  
  // Mapowanie kodu usługi na ObjectId
  if (serviceCode) {
    const service = await Service.findOne({ 
      $or: [
        { code: serviceCode },
        { name: { $regex: serviceCode, $options: 'i' } }
      ]
    });
    if (service) {
      match.service = service._id;
    }
  }
  
  if (cityLike) match.location = { $regex: cityLike, $options: 'i' };

  const since = new Date(Date.now() - days*24*60*60*1000);
  match.createdAt = { $gte: since };

  const docs = await Order.find(match).select('amountTotal').lean();
  const arr = docs.map(d => d.amountTotal).filter(Boolean).sort((a,b)=>a-b);
  if (arr.length < 5) return null;

  const p25 = percentile(arr, 25);
  const p50 = percentile(arr, 50);
  const p75 = percentile(arr, 75);

  return {
    basic:    { min: Math.round(p25*0.85), max: p50 },
    standard: { min: Math.round(p50*0.9),  max: p75 },
    pro:      { min: Math.round(p75*0.9),  max: Math.round(p75*1.2) },
    sampleSize: arr.length,
    windowDays: days
  };
}

module.exports = { computePricingBands, priceHintsFromHistory };



