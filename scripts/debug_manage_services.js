require('dotenv').config();
const fetch = require('node-fetch');

(async () => {
  const API = process.env.API_URL || 'http://localhost:5002';
  const limit = 1000;
  const [servicesRes, categoriesRes] = await Promise.all([
    fetch(`${API}/api/services?limit=${limit}`),
    fetch(`${API}/api/services/categories`)
  ]);
  const servicesData = await servicesRes.json();
  const categoriesData = await categoriesRes.json();
  const services = servicesData.items || [];
  const categories = categoriesData.items || categoriesData.categories || [];

  const servicesBySlug = new Map(services.map(s => [s.slug, s]));
  const normalized = categories.map(cat => ({
    slug: cat.id || cat.slug,
    services: (cat.subcategories || []).map(sub => servicesBySlug.get(sub.id)).filter(Boolean)
  }));
  const combined = normalized.filter(cat => cat.services.length > 0);
  console.log('Categories total:', categories.length);
  console.log('Combined categories with services:', combined.length);
  if (combined.length === 0) {
    console.log('First category sample:', normalized[0]);
  }
})();










