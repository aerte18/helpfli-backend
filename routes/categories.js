const express = require('express');
const router = express.Router();
// In serverless (Vercel) static require ensures the JSON gets bundled
let categoriesData = [];
try {
  categoriesData = require('../data/categories_pl.json');
  if (!Array.isArray(categoriesData)) {
    console.warn('categories_pl.json is not an array, using empty array');
    categoriesData = [];
  }
} catch (err) {
  console.error('Failed to load categories_pl.json:', err.message);
  categoriesData = [];
}

// GET /api/categories
router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '0', 10) || 0, 200);
    const items = limit > 0 ? categoriesData.slice(0, limit) : categoriesData;
    res.json({ success: true, items, count: items.length });
  } catch (err) {
    console.error('categories:list', err);
    res.status(500).json({ success: false, message: 'Błąd pobierania kategorii' });
  }
});

// GET /api/categories/:id
router.get('/:id', (req, res) => {
  try {
    const category = categoriesData.find(c => c.id === req.params.id);
    if (!category) return res.status(404).json({ success: false, message: 'Nie znaleziono kategorii' });
    res.json({ success: true, category });
  } catch (err) {
    console.error('categories:one', err);
    res.status(500).json({ success: false, message: 'Błąd pobierania kategorii' });
  }
});

module.exports = router;
