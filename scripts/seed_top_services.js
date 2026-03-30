require("dotenv").config();
const mongoose = require("mongoose");
const Service = require("../models/Service");
const TOP_SERVICE_SLUGS = require("../constants/topServiceSlugs");

function normalizeSlug(v = "") {
  return String(v).trim().toLowerCase().replace(/_/g, "-");
}

async function run() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/helpfli";
  const shouldReset = process.argv.includes("--reset");
  await mongoose.connect(uri);
  console.log("🔌 Połączono z MongoDB");

  if (shouldReset) {
    const resetRes = await Service.updateMany({}, { $set: { is_top: 0 } });
    console.log(`♻️ Wyzerowano is_top dla: ${resetRes.modifiedCount} usług`);
  }

  const normalized = [...new Set(TOP_SERVICE_SLUGS.map(normalizeSlug))];
  const setRes = await Service.updateMany(
    { slug: { $in: normalized } },
    { $set: { is_top: 1, updated_at: new Date() } }
  );

  const foundDocs = await Service.find({ slug: { $in: normalized } })
    .select("slug name_pl parent_slug is_top")
    .lean();
  const foundSlugs = new Set(foundDocs.map((d) => normalizeSlug(d.slug)));
  const missing = normalized.filter((s) => !foundSlugs.has(s));

  const topCount = await Service.countDocuments({ is_top: { $gt: 0 } });
  console.log("✅ Seed TOP usług zakończony");
  console.log(`   🎯 Ustawiono is_top=1 dla: ${setRes.modifiedCount} usług`);
  console.log(`   📦 TOP usług łącznie w bazie: ${topCount}`);
  if (missing.length > 0) {
    console.log(`   ⚠️ Brakujące slugi (${missing.length}):`);
    missing.forEach((s) => console.log(`      - ${s}`));
  }

  await mongoose.disconnect();
  console.log("🔌 Rozłączono z MongoDB");
}

run().catch((err) => {
  console.error("❌ Błąd seed_top_services:", err);
  process.exit(1);
});

