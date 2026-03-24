const fs = require('fs');
const path = require('path');

// Wczytaj plik serviceCategories.js z frontendu
const frontendPath = path.join(__dirname, '../../frontend/src/data/serviceCategories.js');
const backendPath = path.join(__dirname, '../data/categories_pl.json');

try {
  const content = fs.readFileSync(frontendPath, 'utf8');
  
  // Wyciągnij dane z export const serviceCategories = [...]
  const match = content.match(/export const serviceCategories = (\[[\s\S]*?\]);/);
  
  if (!match) {
    throw new Error('Nie znaleziono serviceCategories w pliku');
  }
  
  // Usuń keywords z każdej podkategorii i przekonwertuj na JSON
  let jsonStr = match[1];
  
  // Usuń keywords: [...] z każdej podkategorii
  jsonStr = jsonStr.replace(/keywords:\s*\[[^\]]*\]/g, '');
  
  // Usuń przecinki przed zamykającymi nawiasami
  jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
  
  // Parsuj jako JavaScript
  const categories = eval('(' + jsonStr + ')');
  
  // Przekonwertuj do formatu JSON (bez keywords)
  const result = categories.map(cat => ({
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    subcategories: cat.subcategories.map(sub => ({
      id: sub.id,
      name: sub.name
    }))
  }));
  
  // Zapisz do pliku JSON
  fs.writeFileSync(backendPath, JSON.stringify(result, null, 2));
  
  console.log('✅ Zaktualizowano categories_pl.json');
  console.log(`   Kategorii: ${result.length}`);
  console.log(`   Przykład: ${result[0].name} - ${result[0].subcategories.length} podkategorii`);
} catch (error) {
  console.error('❌ Błąd:', error.message);
  process.exit(1);
}










