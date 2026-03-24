require('dotenv').config();
const fetch = require('node-fetch');

(async () => {
  const API = process.env.API_URL || 'http://localhost:5002';
  const servicesRes = await fetch(`${API}/api/services?limit=1000`);
  const categoriesRes = await fetch(`${API}/api/services/categories`);
  const servicesData = await servicesRes.json();
  const categoriesData = await categoriesRes.json();
  const services = servicesData.items || [];
  const categories = categoriesData.items || categoriesData.categories || [];

  const servicesBySlug = new Map(services.map(s => [s.slug, s]));
  const missing = categories
    .map(cat => ({
      slug: cat.id || cat.slug,
      missing: (cat.subcategories || []).filter(sub => !servicesBySlug.has(sub.id))
    }))
    .filter(cat => cat.missing.length > 0);

  console.log('total categories:', categories.length);
  console.log('categories with missing services:', missing.length);
  missing.slice(0, 5).forEach(cat => {
    console.log(cat.slug, 'missing', cat.missing.map(sub => sub.id).join(', '));
  });
})();










