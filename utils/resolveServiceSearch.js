const Service = require("../models/Service");

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  let docs = await Service.find({ $or: orConditions })
    .select("_id parent_slug slug name_pl name_en")
    .lean();

  // Gdy frontend wysłał skrócony / „obcięty” slug (np. agd-instalacja-okapu zamiast
  // agd-rtv-instalacja-okapu-zabudowa-agd), dopasuj po kolejnych tokenach w polu slug.
  if (!docs.length && slugList.length) {
    const fallback = await findServicesBySlugFragmentPattern(slugList);
    docs = fallback;
  }

  const seen = new Map();
  for (const d of docs) {
    if (!seen.has(String(d._id))) seen.set(String(d._id), d);
  }
  const uniqueDocs = [...seen.values()];
  const ids = uniqueDocs.map((d) => d._id);

  return { ids, docs: uniqueDocs, hadServiceTokens: true };
}

/**
 * Dopasowanie po ≥2 tokenach (min. 4 znaki), kolejność w slug: token1…token2
 * (np. instalacja + okapu → trafi w agd-rtv-instalacja-okapu-zabudowa-agd).
 */
async function findServicesBySlugFragmentPattern(slugList) {
  const out = [];
  for (const slug of slugList) {
    const raw = String(slug).trim().toLowerCase().replace(/_/g, "-");
    const parts = raw.split("-").filter((p) => p.length >= 4);
    if (parts.length >= 2) {
      const pattern = parts.map(escapeRegex).join(".*");
      const found = await Service.find({ slug: { $regex: pattern, $options: "i" } })
        .select("_id parent_slug slug name_pl name_en")
        .limit(40)
        .lean();
      out.push(...found);
    }
  }
  const seen = new Map();
  for (const d of out) {
    if (!seen.has(String(d._id))) seen.set(String(d._id), d);
  }
  return [...seen.values()];
}

module.exports = {
  resolveServicesForSearchFilter,
  slugSuffixVariants,
};
