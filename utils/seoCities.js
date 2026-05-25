/**
 * Katalog polskich miast + dzielnic dla Programmatic SEO (Helpfli).
 *
 * Cel:
 *  - generujemy szablony landing pages `/uslugi/:serviceSlug/:citySlug`
 *  - każda strona = unikalny tytuł, opis i listing wykonawców z bazy,
 *  - sitemap automatycznie publikuje cały iloczyn (usługa × miasto).
 *
 * Dane są kanoniczne (slug bez polskich znaków + display w mianowniku/miejscowniku).
 * Format identyczny we wszystkich miastach: { slug, name, locative, voivodeship, population, isCapital }
 *
 * Zmieniaj plik świadomie — slug = adres URL = backlinki. Nie zmieniaj slugów już opublikowanych miast.
 */

const SEO_CITIES = [
  // --- TOP 6 (1m+ ruchu) ---
  { slug: 'warszawa',  name: 'Warszawa',  locative: 'Warszawie',  voivodeship: 'mazowieckie',         population: 1860000, isCapital: true },
  { slug: 'krakow',    name: 'Kraków',    locative: 'Krakowie',   voivodeship: 'małopolskie',         population: 800000 },
  { slug: 'lodz',      name: 'Łódź',      locative: 'Łodzi',      voivodeship: 'łódzkie',             population: 660000 },
  { slug: 'wroclaw',   name: 'Wrocław',   locative: 'Wrocławiu',  voivodeship: 'dolnośląskie',        population: 640000 },
  { slug: 'poznan',    name: 'Poznań',    locative: 'Poznaniu',   voivodeship: 'wielkopolskie',       population: 530000 },
  { slug: 'gdansk',    name: 'Gdańsk',    locative: 'Gdańsku',    voivodeship: 'pomorskie',           population: 470000 },
  // --- 200k–500k (mocny long tail) ---
  { slug: 'szczecin',         name: 'Szczecin',         locative: 'Szczecinie',         voivodeship: 'zachodniopomorskie',  population: 395000 },
  { slug: 'bydgoszcz',        name: 'Bydgoszcz',        locative: 'Bydgoszczy',         voivodeship: 'kujawsko-pomorskie',  population: 343000 },
  { slug: 'lublin',           name: 'Lublin',           locative: 'Lublinie',           voivodeship: 'lubelskie',           population: 335000 },
  { slug: 'bialystok',        name: 'Białystok',        locative: 'Białymstoku',        voivodeship: 'podlaskie',           population: 296000 },
  { slug: 'katowice',         name: 'Katowice',         locative: 'Katowicach',         voivodeship: 'śląskie',             population: 290000 },
  { slug: 'gdynia',           name: 'Gdynia',           locative: 'Gdyni',              voivodeship: 'pomorskie',           population: 247000 },
  { slug: 'czestochowa',      name: 'Częstochowa',      locative: 'Częstochowie',       voivodeship: 'śląskie',             population: 220000 },
  { slug: 'radom',            name: 'Radom',            locative: 'Radomiu',            voivodeship: 'mazowieckie',         population: 213000 },
  { slug: 'rzeszow',          name: 'Rzeszów',          locative: 'Rzeszowie',          voivodeship: 'podkarpackie',        population: 197000 },
  { slug: 'torun',            name: 'Toruń',            locative: 'Toruniu',            voivodeship: 'kujawsko-pomorskie',  population: 200000 },
  { slug: 'sosnowiec',        name: 'Sosnowiec',        locative: 'Sosnowcu',           voivodeship: 'śląskie',             population: 200000 },
  { slug: 'kielce',           name: 'Kielce',           locative: 'Kielcach',           voivodeship: 'świętokrzyskie',      population: 195000 },
  { slug: 'gliwice',          name: 'Gliwice',          locative: 'Gliwicach',          voivodeship: 'śląskie',             population: 178000 },
  { slug: 'olsztyn',          name: 'Olsztyn',          locative: 'Olsztynie',          voivodeship: 'warmińsko-mazurskie', population: 170000 },
  { slug: 'zabrze',           name: 'Zabrze',           locative: 'Zabrzu',             voivodeship: 'śląskie',             population: 169000 },
  { slug: 'bielsko-biala',    name: 'Bielsko-Biała',    locative: 'Bielsku-Białej',     voivodeship: 'śląskie',             population: 167000 },
  { slug: 'bytom',            name: 'Bytom',            locative: 'Bytomiu',            voivodeship: 'śląskie',             population: 162000 },
  { slug: 'zielona-gora',     name: 'Zielona Góra',     locative: 'Zielonej Górze',     voivodeship: 'lubuskie',            population: 141000 },
  { slug: 'rybnik',           name: 'Rybnik',           locative: 'Rybniku',            voivodeship: 'śląskie',             population: 137000 },
  { slug: 'ruda-slaska',      name: 'Ruda Śląska',      locative: 'Rudzie Śląskiej',    voivodeship: 'śląskie',             population: 137000 },
  { slug: 'opole',            name: 'Opole',            locative: 'Opolu',              voivodeship: 'opolskie',            population: 127000 },
  { slug: 'tychy',            name: 'Tychy',            locative: 'Tychach',            voivodeship: 'śląskie',             population: 126000 },
  { slug: 'gorzow-wielkopolski', name: 'Gorzów Wielkopolski', locative: 'Gorzowie Wielkopolskim', voivodeship: 'lubuskie', population: 122000 },
  { slug: 'dabrowa-gornicza', name: 'Dąbrowa Górnicza', locative: 'Dąbrowie Górniczej', voivodeship: 'śląskie',             population: 120000 },
  { slug: 'plock',            name: 'Płock',            locative: 'Płocku',             voivodeship: 'mazowieckie',         population: 119000 },
  { slug: 'elblag',           name: 'Elbląg',           locative: 'Elblągu',            voivodeship: 'warmińsko-mazurskie', population: 117000 },
  { slug: 'walbrzych',        name: 'Wałbrzych',        locative: 'Wałbrzychu',         voivodeship: 'dolnośląskie',        population: 110000 },
  { slug: 'wloclawek',        name: 'Włocławek',        locative: 'Włocławku',          voivodeship: 'kujawsko-pomorskie',  population: 109000 },
  { slug: 'tarnow',           name: 'Tarnów',           locative: 'Tarnowie',           voivodeship: 'małopolskie',         population: 107000 },
  { slug: 'chorzow',          name: 'Chorzów',          locative: 'Chorzowie',          voivodeship: 'śląskie',             population: 107000 },
  { slug: 'koszalin',         name: 'Koszalin',         locative: 'Koszalinie',         voivodeship: 'zachodniopomorskie',  population: 106000 },
  { slug: 'kalisz',           name: 'Kalisz',           locative: 'Kaliszu',            voivodeship: 'wielkopolskie',       population: 101000 },
  { slug: 'legnica',          name: 'Legnica',          locative: 'Legnicy',            voivodeship: 'dolnośląskie',        population: 99000 },
  { slug: 'grudziadz',        name: 'Grudziądz',        locative: 'Grudziądzu',         voivodeship: 'kujawsko-pomorskie',  population: 95000 },
  { slug: 'slupsk',           name: 'Słupsk',           locative: 'Słupsku',            voivodeship: 'pomorskie',           population: 91000 },
  { slug: 'jaworzno',         name: 'Jaworzno',         locative: 'Jaworznie',          voivodeship: 'śląskie',             population: 91000 },
  { slug: 'jastrzebie-zdroj', name: 'Jastrzębie-Zdrój', locative: 'Jastrzębiu-Zdroju',  voivodeship: 'śląskie',             population: 89000 },
  { slug: 'nowy-sacz',        name: 'Nowy Sącz',        locative: 'Nowym Sączu',        voivodeship: 'małopolskie',         population: 83000 },
  { slug: 'jelenia-gora',     name: 'Jelenia Góra',     locative: 'Jeleniej Górze',     voivodeship: 'dolnośląskie',        population: 78000 },
  { slug: 'siedlce',          name: 'Siedlce',          locative: 'Siedlcach',          voivodeship: 'mazowieckie',         population: 77000 },
  { slug: 'mysłowice',        name: 'Mysłowice',        locative: 'Mysłowicach',        voivodeship: 'śląskie',             population: 74000 },
  { slug: 'pila',             name: 'Piła',             locative: 'Pile',               voivodeship: 'wielkopolskie',       population: 73000 },
  { slug: 'ostrow-wielkopolski', name: 'Ostrów Wielkopolski', locative: 'Ostrowie Wielkopolskim', voivodeship: 'wielkopolskie', population: 71000 },
  { slug: 'lubin',            name: 'Lubin',            locative: 'Lubinie',            voivodeship: 'dolnośląskie',        population: 71000 },
  { slug: 'gniezno',          name: 'Gniezno',          locative: 'Gnieźnie',           voivodeship: 'wielkopolskie',       population: 67000 }
];

/**
 * Dzielnice dla TOP 4 miast — kolejny poziom long-tail
 * (np. "hydraulik Mokotów" — niski volume, ale zerowa konkurencja).
 *
 * Kanoniczny slug dzielnicy = `${citySlug}-${districtSlug}`,
 * a URL = `/uslugi/:service/:citySlug/:districtSlug` (lub plaski słownik).
 *
 * Trzymamy je opcjonalnie — można odpalić tylko jako 2-gą falę.
 */
const SEO_DISTRICTS = {
  warszawa: [
    { slug: 'mokotow',         name: 'Mokotów',         locative: 'Mokotowie' },
    { slug: 'srodmiescie',     name: 'Śródmieście',     locative: 'Śródmieściu' },
    { slug: 'wola',            name: 'Wola',            locative: 'Woli' },
    { slug: 'ursynow',         name: 'Ursynów',         locative: 'Ursynowie' },
    { slug: 'bemowo',          name: 'Bemowo',          locative: 'Bemowie' },
    { slug: 'bielany',         name: 'Bielany',         locative: 'Bielanach' },
    { slug: 'targowek',        name: 'Targówek',        locative: 'Targówku' },
    { slug: 'praga-poludnie',  name: 'Praga-Południe',  locative: 'Pradze-Południe' },
    { slug: 'praga-polnoc',    name: 'Praga-Północ',    locative: 'Pradze-Północ' },
    { slug: 'bialoleka',       name: 'Białołęka',       locative: 'Białołęce' },
    { slug: 'wilanow',         name: 'Wilanów',         locative: 'Wilanowie' },
    { slug: 'ochota',          name: 'Ochota',          locative: 'Ochocie' },
    { slug: 'zoliborz',        name: 'Żoliborz',        locative: 'Żoliborzu' }
  ],
  krakow: [
    { slug: 'stare-miasto',    name: 'Stare Miasto',    locative: 'Starym Mieście' },
    { slug: 'kazimierz',       name: 'Kazimierz',       locative: 'Kazimierzu' },
    { slug: 'podgorze',        name: 'Podgórze',        locative: 'Podgórzu' },
    { slug: 'krowodrza',       name: 'Krowodrza',       locative: 'Krowodrzy' },
    { slug: 'nowa-huta',       name: 'Nowa Huta',       locative: 'Nowej Hucie' },
    { slug: 'pradnik-bialy',   name: 'Prądnik Biały',   locative: 'Prądniku Białym' },
    { slug: 'pradnik-czerwony',name: 'Prądnik Czerwony',locative: 'Prądniku Czerwonym' },
    { slug: 'lagiewniki',      name: 'Łagiewniki',      locative: 'Łagiewnikach' }
  ],
  wroclaw: [
    { slug: 'stare-miasto',    name: 'Stare Miasto',    locative: 'Starym Mieście' },
    { slug: 'krzyki',          name: 'Krzyki',          locative: 'Krzykach' },
    { slug: 'fabryczna',       name: 'Fabryczna',       locative: 'Fabrycznej' },
    { slug: 'psie-pole',       name: 'Psie Pole',       locative: 'Psim Polu' },
    { slug: 'srodmiescie',     name: 'Śródmieście',     locative: 'Śródmieściu' }
  ],
  poznan: [
    { slug: 'stare-miasto',    name: 'Stare Miasto',    locative: 'Starym Mieście' },
    { slug: 'jezyce',          name: 'Jeżyce',          locative: 'Jeżycach' },
    { slug: 'grunwald',        name: 'Grunwald',        locative: 'Grunwaldzie' },
    { slug: 'wilda',           name: 'Wilda',           locative: 'Wildzie' },
    { slug: 'nowe-miasto',     name: 'Nowe Miasto',     locative: 'Nowym Mieście' }
  ],
  gdansk: [
    { slug: 'stare-miasto',    name: 'Stare Miasto',    locative: 'Starym Mieście' },
    { slug: 'wrzeszcz',        name: 'Wrzeszcz',        locative: 'Wrzeszczu' },
    { slug: 'oliwa',           name: 'Oliwa',           locative: 'Oliwie' },
    { slug: 'przymorze',       name: 'Przymorze',       locative: 'Przymorzu' },
    { slug: 'zaspa',           name: 'Zaspa',           locative: 'Zaspie' }
  ]
};

/**
 * Lista usług, dla których publikujemy strony PSEO `/uslugi/:service/:city`.
 * Format: { slug, name, namePlural, namePerson, category, baseAvgPrice, basePriceUnit }
 *
 * Nie trzeba zwiększać tej listy do setek — wystarczy 30–50 mocnych usług,
 * iloczyn z 50 miastami = ~2 000 stron (sweet spot ROI vs jakość).
 *
 * NB: slug musi pasować do slugów Service w bazie (jeśli usługa jest w katalogu
 * Helpfli — pobierzemy z bazy realnych providerów). Jeśli nie pasuje → nie zaszkodzi,
 * po prostu landing nie będzie mieć providerów (ale i tak będzie unikalna treść).
 */
const SEO_LOCAL_SERVICES = [
  // hydraulik
  { slug: 'hydraulik',              name: 'Hydraulik',           namePlural: 'hydraulicy',           namePerson: 'hydraulika',           category: 'hydraulik',  baseAvgPrice: 180 },
  { slug: 'udraznianie-rur',        name: 'Udrażnianie rur',     namePlural: 'fachowcy od udrażniania', namePerson: 'specjalisty',       category: 'hydraulik',  baseAvgPrice: 200 },
  { slug: 'wymiana-baterii',        name: 'Wymiana baterii',     namePlural: 'hydraulicy',           namePerson: 'hydraulika',           category: 'hydraulik',  baseAvgPrice: 150 },
  { slug: 'naprawa-bojlera',        name: 'Naprawa bojlera',     namePlural: 'serwisanci bojlerów',  namePerson: 'serwisanta',           category: 'hydraulik',  baseAvgPrice: 250 },
  { slug: 'montaz-zmywarki',        name: 'Montaż zmywarki',     namePlural: 'hydraulicy',           namePerson: 'hydraulika',           category: 'hydraulik',  baseAvgPrice: 250 },
  { slug: 'montaz-pralki',          name: 'Montaż pralki',       namePlural: 'hydraulicy',           namePerson: 'hydraulika',           category: 'hydraulik',  baseAvgPrice: 200 },
  // elektryk
  { slug: 'elektryk',               name: 'Elektryk',            namePlural: 'elektrycy',            namePerson: 'elektryka',            category: 'elektryk',   baseAvgPrice: 200 },
  { slug: 'wymiana-gniazdka',       name: 'Wymiana gniazdka',    namePlural: 'elektrycy',            namePerson: 'elektryka',            category: 'elektryk',   baseAvgPrice: 80 },
  { slug: 'instalacja-elektryczna', name: 'Instalacja elektryczna', namePlural: 'elektrycy',         namePerson: 'elektryka',            category: 'elektryk',   baseAvgPrice: 350 },
  { slug: 'podlaczenie-indukcji',   name: 'Podłączenie indukcji',namePlural: 'elektrycy',            namePerson: 'elektryka',            category: 'elektryk',   baseAvgPrice: 250 },
  // AGD
  { slug: 'naprawa-agd',            name: 'Naprawa AGD',         namePlural: 'serwisanci AGD',       namePerson: 'serwisanta',           category: 'agd',        baseAvgPrice: 220 },
  { slug: 'naprawa-pralki',         name: 'Naprawa pralki',      namePlural: 'serwisanci pralek',    namePerson: 'serwisanta',           category: 'agd',        baseAvgPrice: 230 },
  { slug: 'naprawa-zmywarki',       name: 'Naprawa zmywarki',    namePlural: 'serwisanci zmywarek',  namePerson: 'serwisanta',           category: 'agd',        baseAvgPrice: 240 },
  { slug: 'naprawa-lodowki',        name: 'Naprawa lodówki',     namePlural: 'serwisanci lodówek',   namePerson: 'serwisanta',           category: 'agd',        baseAvgPrice: 250 },
  { slug: 'naprawa-piekarnika',     name: 'Naprawa piekarnika',  namePlural: 'serwisanci',           namePerson: 'serwisanta',           category: 'agd',        baseAvgPrice: 220 },
  // ogrzewanie
  { slug: 'serwis-pieca-gazowego',  name: 'Serwis pieca gazowego', namePlural: 'serwisanci pieców', namePerson: 'serwisanta',           category: 'ogrzewanie', baseAvgPrice: 350 },
  { slug: 'odpowietrzanie-kaloryferow', name: 'Odpowietrzanie kaloryferów', namePlural: 'hydraulicy', namePerson: 'hydraulika',         category: 'ogrzewanie', baseAvgPrice: 120 },
  // klimatyzacja
  { slug: 'serwis-klimatyzacji',    name: 'Serwis klimatyzacji', namePlural: 'serwisanci klimatyzacji', namePerson: 'serwisanta',       category: 'klimatyzacja', baseAvgPrice: 300 },
  { slug: 'montaz-klimatyzacji',    name: 'Montaż klimatyzacji', namePlural: 'instalatorzy klimatyzacji', namePerson: 'instalatora',    category: 'klimatyzacja', baseAvgPrice: 2200 },
  // remont
  { slug: 'malowanie-mieszkania',   name: 'Malowanie mieszkania',namePlural: 'malarze',              namePerson: 'malarza',              category: 'remont',     baseAvgPrice: 35,    basePriceUnit: 'm²' },
  { slug: 'glazurnik',              name: 'Glazurnik',           namePlural: 'glazurnicy',           namePerson: 'glazurnika',           category: 'remont',     baseAvgPrice: 120,   basePriceUnit: 'm²' },
  { slug: 'remont-lazienki',        name: 'Remont łazienki',     namePlural: 'wykonawcy',            namePerson: 'wykonawcy',            category: 'remont',     baseAvgPrice: 15000 },
  { slug: 'remont-kuchni',          name: 'Remont kuchni',       namePlural: 'wykonawcy',            namePerson: 'wykonawcy',            category: 'remont',     baseAvgPrice: 18000 },
  { slug: 'tapeciarz',              name: 'Tapeciarz',           namePlural: 'tapeciarze',           namePerson: 'tapeciarza',           category: 'remont',     baseAvgPrice: 40,    basePriceUnit: 'm²' },
  // stolarz
  { slug: 'stolarz',                name: 'Stolarz',             namePlural: 'stolarze',             namePerson: 'stolarza',             category: 'stolarz',    baseAvgPrice: 200 },
  { slug: 'montaz-drzwi',           name: 'Montaż drzwi',        namePlural: 'stolarze',             namePerson: 'stolarza',             category: 'stolarz',    baseAvgPrice: 300 },
  { slug: 'regulacja-okien',        name: 'Regulacja okien',     namePlural: 'serwisanci stolarki',  namePerson: 'serwisanta',           category: 'stolarz',    baseAvgPrice: 150 },
  // sprzątanie
  { slug: 'sprzatanie-po-remoncie', name: 'Sprzątanie po remoncie', namePlural: 'firmy sprzątające', namePerson: 'firmy sprzątającej',  category: 'sprzatanie', baseAvgPrice: 12,    basePriceUnit: 'm²' },
  { slug: 'pranie-tapicerki',       name: 'Pranie tapicerki',    namePlural: 'firmy do prania tapicerki', namePerson: 'specjalisty',     category: 'sprzatanie', baseAvgPrice: 200 },
  // ogród
  { slug: 'koszenie-trawy',         name: 'Koszenie trawnika',   namePlural: 'firmy ogrodnicze',     namePerson: 'ogrodnika',            category: 'ogrod',      baseAvgPrice: 2,     basePriceUnit: 'm²' },
  { slug: 'przycinanie-drzew',      name: 'Przycinanie drzew',   namePlural: 'arboryści',            namePerson: 'arborysty',            category: 'ogrod',      baseAvgPrice: 200 },
  // dezynsekcja
  { slug: 'dezynsekcja',            name: 'Dezynsekcja',         namePlural: 'firmy DDD',            namePerson: 'firmy DDD',            category: 'dezynsekcja', baseAvgPrice: 250 }
];

function getCityBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const key = slug.toLowerCase().trim();
  return SEO_CITIES.find((c) => c.slug === key) || null;
}

function getServiceBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const key = slug.toLowerCase().trim();
  return SEO_LOCAL_SERVICES.find((s) => s.slug === key) || null;
}

/**
 * Zwraca obiekt dzielnicy dla `citySlug` / `districtSlug` (oba lowercase).
 * Zwraca null jeśli citySlug nie ma dzielnic albo districtSlug nie istnieje.
 */
function getDistrictBySlug(citySlug, districtSlug) {
  if (!citySlug || !districtSlug) return null;
  const cityKey = String(citySlug).toLowerCase().trim();
  const dKey = String(districtSlug).toLowerCase().trim();
  const list = SEO_DISTRICTS[cityKey];
  if (!Array.isArray(list)) return null;
  return list.find((d) => d.slug === dKey) || null;
}

/** Lista dzielnic dla danego miasta (lub []). */
function listDistricts(citySlug) {
  const key = String(citySlug || '').toLowerCase().trim();
  return Array.isArray(SEO_DISTRICTS[key]) ? SEO_DISTRICTS[key] : [];
}

/** Lista wszystkich par (service, city) — do sitemap i bootstrapu cronów. */
function listAllLocalPairs() {
  const out = [];
  for (const s of SEO_LOCAL_SERVICES) {
    for (const c of SEO_CITIES) {
      out.push({ service: s, city: c });
    }
  }
  return out;
}

/** Lista wszystkich trójek (service, city, district) – matrix dzielnic. */
function listAllDistrictTriples() {
  const out = [];
  for (const s of SEO_LOCAL_SERVICES) {
    for (const c of SEO_CITIES) {
      const districts = listDistricts(c.slug);
      for (const d of districts) {
        out.push({ service: s, city: c, district: d });
      }
    }
  }
  return out;
}

module.exports = {
  SEO_CITIES,
  SEO_DISTRICTS,
  SEO_LOCAL_SERVICES,
  getCityBySlug,
  getServiceBySlug,
  getDistrictBySlug,
  listDistricts,
  listAllLocalPairs,
  listAllDistrictTriples
};
