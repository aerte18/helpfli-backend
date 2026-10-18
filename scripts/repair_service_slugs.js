require('dotenv').config();
const mongoose = require('mongoose');
const Service = require('../models/Service');
const SeoLocalPage = require('../models/SeoLocalPage');
const { buildCanonicalServiceSlug } = require('../utils/seoSlug');

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/helpfli';
  await mongoose.connect(uri);

  const services = await Service.find({}).select('_id slug legacy_slugs parent_slug name_pl name_en name').lean();
  const occupied = new Map(services.map((service) => [service.slug, String(service._id)]));
  const plans = [];
  const conflicts = [];

  for (const service of services) {
    const canonical = buildCanonicalServiceSlug(service);
    if (!canonical || canonical === service.slug) continue;
    const owner = occupied.get(canonical);
    if (owner && owner !== String(service._id)) {
      conflicts.push({ id: String(service._id), from: service.slug, to: canonical, owner });
      continue;
    }
    plans.push({ id: String(service._id), from: service.slug, to: canonical });
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', changes: plans.length, conflicts }, null, 2));
  for (const plan of plans) console.log(`${plan.from} -> ${plan.to}`);

  if (!apply) {
    console.log('Dry run: uruchom ponownie z --apply, aby zapisać zmiany.');
    return;
  }
  if (conflicts.length) {
    throw new Error('Przerwano: najpierw rozwiąż konflikty slugów pokazane w raporcie.');
  }

  for (const plan of plans) {
    const pages = await SeoLocalPage.find({ serviceSlug: plan.from }).select('_id citySlug').lean();
    for (const page of pages) {
      const duplicate = await SeoLocalPage.exists({
        _id: { $ne: page._id },
        serviceSlug: plan.to,
        citySlug: page.citySlug
      });
      if (duplicate) {
        throw new Error(`Konflikt PSEO: ${plan.to}/${page.citySlug}`);
      }
    }

    await Service.updateOne(
      { _id: plan.id },
      {
        $set: { slug: plan.to, updated_at: new Date() },
        $addToSet: { legacy_slugs: plan.from }
      }
    );
    for (const page of pages) {
      await SeoLocalPage.updateOne(
        { _id: page._id },
        { $set: { serviceSlug: plan.to, slug: `${plan.to}-${page.citySlug}` } }
      );
    }
  }

  console.log(`Zaktualizowano ${plans.length} slugów usług.`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
