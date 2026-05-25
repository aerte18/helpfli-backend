/**
 * Lista miast PL używana przez:
 *  - PSEO (matryca miasto × usługa)
 *  - LiveStats (statystyki marketplace dla konkretnego miasta)
 *  - Sitemap (URLs landing pages)
 *
 * Dobór: 30 największych miast PL (>100k mieszkańców) + kluczowe pod kątem
 * popytu na usługi (Warszawa, Kraków, Wrocław, Poznań, Gdańsk, Łódź...).
 *
 * Slug: forma URL-friendly (małe litery, bez polskich znaków, myślniki).
 * Aliases: alternatywne formy używane do dopasowywania `Order.city` /
 * `User.location` z bazy danych (mianownik + miejscownik).
 */

const TOP_PL_CITIES = [
  { name: 'Warszawa',  slug: 'warszawa',  aliases: ['warszawa', 'warszawie', 'warszawy', 'warsaw'] },
  { name: 'Kraków',    slug: 'krakow',    aliases: ['kraków', 'krakow', 'krakowie', 'krakowa', 'cracow'] },
  { name: 'Łódź',      slug: 'lodz',      aliases: ['łódź', 'lodz', 'łodzi', 'lodzi'] },
  { name: 'Wrocław',   slug: 'wroclaw',   aliases: ['wrocław', 'wroclaw', 'wrocławiu', 'wroclawiu'] },
  { name: 'Poznań',    slug: 'poznan',    aliases: ['poznań', 'poznan', 'poznaniu'] },
  { name: 'Gdańsk',    slug: 'gdansk',    aliases: ['gdańsk', 'gdansk', 'gdańsku', 'gdansku'] },
  { name: 'Szczecin',  slug: 'szczecin',  aliases: ['szczecin', 'szczecinie'] },
  { name: 'Bydgoszcz', slug: 'bydgoszcz', aliases: ['bydgoszcz', 'bydgoszczy'] },
  { name: 'Lublin',    slug: 'lublin',    aliases: ['lublin', 'lublinie'] },
  { name: 'Białystok', slug: 'bialystok', aliases: ['białystok', 'bialystok', 'białymstoku', 'bialymstoku'] },
  { name: 'Katowice',  slug: 'katowice',  aliases: ['katowice', 'katowicach'] },
  { name: 'Gdynia',    slug: 'gdynia',    aliases: ['gdynia', 'gdyni'] },
  { name: 'Częstochowa', slug: 'czestochowa', aliases: ['częstochowa', 'czestochowa', 'częstochowie', 'czestochowie'] },
  { name: 'Radom',     slug: 'radom',     aliases: ['radom', 'radomiu'] },
  { name: 'Sosnowiec', slug: 'sosnowiec', aliases: ['sosnowiec', 'sosnowcu'] },
  { name: 'Toruń',     slug: 'torun',     aliases: ['toruń', 'torun', 'toruniu'] },
  { name: 'Kielce',    slug: 'kielce',    aliases: ['kielce', 'kielcach'] },
  { name: 'Rzeszów',   slug: 'rzeszow',   aliases: ['rzeszów', 'rzeszow', 'rzeszowie'] },
  { name: 'Gliwice',   slug: 'gliwice',   aliases: ['gliwice', 'gliwicach'] },
  { name: 'Zabrze',    slug: 'zabrze',    aliases: ['zabrze', 'zabrzu'] },
  { name: 'Olsztyn',   slug: 'olsztyn',   aliases: ['olsztyn', 'olsztynie'] },
  { name: 'Bielsko-Biała', slug: 'bielsko-biala', aliases: ['bielsko-biała', 'bielsko-biala', 'bielsku-białej', 'bielsku-bialej'] },
  { name: 'Bytom',     slug: 'bytom',     aliases: ['bytom', 'bytomiu'] },
  { name: 'Zielona Góra', slug: 'zielona-gora', aliases: ['zielona góra', 'zielona gora', 'zielonej górze', 'zielonej gorze'] },
  { name: 'Rybnik',    slug: 'rybnik',    aliases: ['rybnik', 'rybniku'] },
  { name: 'Ruda Śląska', slug: 'ruda-slaska', aliases: ['ruda śląska', 'ruda slaska', 'rudzie śląskiej', 'rudzie slaskiej'] },
  { name: 'Tychy',     slug: 'tychy',     aliases: ['tychy', 'tychach'] },
  { name: 'Opole',     slug: 'opole',     aliases: ['opole', 'opolu'] },
  { name: 'Gorzów Wielkopolski', slug: 'gorzow-wielkopolski', aliases: ['gorzów wielkopolski', 'gorzow wielkopolski', 'gorzowie'] },
  { name: 'Elbląg',    slug: 'elblag',    aliases: ['elbląg', 'elblag', 'elblągu', 'elblagu'] }
];

const TOP_PL_CITIES_BY_SLUG = TOP_PL_CITIES.reduce((acc, c) => {
  acc[c.slug] = c;
  return acc;
}, {});

/**
 * Spróbuj odgadnąć slug miasta z tekstu (np. "Warszawa" → "warszawa",
 * "we Wrocławiu" → "wroclaw"). Wraca null, jeśli nie znamy miasta.
 */
function detectCitySlug(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const city of TOP_PL_CITIES) {
    for (const a of city.aliases) {
      if (lower.includes(a)) return city.slug;
    }
  }
  return null;
}

module.exports = {
  TOP_PL_CITIES,
  TOP_PL_CITIES_BY_SLUG,
  detectCitySlug
};
