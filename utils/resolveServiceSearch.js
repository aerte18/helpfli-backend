const Service = require("../models/Service");

/**
 * Warianty slugów: pełny slug + sufiksy po "ucięciu" prefiksu kategorii
 * (np. agd-rtv-naprawa-agd → naprawa-agd).
 */
function slugSuffixVariants(slug) {
  if (!slug || typeof slug !== "string") return [];
  const raw = slug.trim().toLowerCase().replace(/_/g, "-");
  const parts = raw.split("-").filter(Boolean);
  const out = new Set([raw, slug.trim()]);
  for (let i = 1; i < parts.length; i++) {
    out.add(parts.slice(i).join("-"));
  }
  return [...out];
}

function isProbableObjectId(s) {
  return /^[a-fA-F0-9]{24}$/.test(String(s).trim());
}

/**
 * Rozwiązuje parametr `service` (CSV: ObjectId lub slug kategorii/usługi) do listy _id w kolekcji Service.
 * @returns {Promise<{ ids: import('mongoose').Types.ObjectId[], docs: object[], hadServiceTokens: boolean }>}
 */
async function resolveServicesForSearchFilter(serviceParam) {
  if (serviceParam == null || String(serviceParam).trim() === "") {
    return { ids: [], docs: [], hadServiceTokens: false };
  }

  const serviceList = String(serviceParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!serviceList.length) {
    return { ids: [], docs: [], hadServiceTokens: false };
  }

  const idList = serviceList.filter(isProbableObjectId);
  const slugList = serviceList.filter((s) => !isProbableObjectId(s));

  const variantSet = new Set();
  for (const s of slugList) {
    slugSuffixVariants(s).forEach((v) => variantSet.add(v));
  }
  const slugVariants = [...variantSet];

  const orConditions = [];
  if (idList.length) {
    orConditions.push({ _id: { $in: idList } });
  }
  if (slugList.length) {
    orConditions.push({ parent_slug: { $in: slugList } });
  }
  if (slugVariants.length) {
    orConditions.push({ slug: { $in: slugVariants } });
  }

  if (!orConditions.length) {
    return { ids: [], docs: [], hadServiceTokens: true };
  }

  const docs = await Service.find({ $or: orConditions })
    .select("_id parent_slug slug name_pl name_en")
    .lean();

  const seen = new Map();
  for (const d of docs) {
    if (!seen.has(String(d._id))) seen.set(String(d._id), d);
  }
  const uniqueDocs = [...seen.values()];
  const ids = uniqueDocs.map((d) => d._id);

  return { ids, docs: uniqueDocs, hadServiceTokens: true };
}

module.exports = {
  resolveServicesForSearchFilter,
  slugSuffixVariants,
};
