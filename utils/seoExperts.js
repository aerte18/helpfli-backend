/**
 * SEO Experts catalog – realne osoby (zespół Helpfli) wskazywane jako autorzy
 * i recenzenci poradników w Article JSON-LD oraz na UI.
 *
 * Cel: E-E-A-T (Expertise, Experience, Authoritativeness, Trustworthiness).
 * Google docenia konkretne, nazwane autorstwo zamiast "Organization Helpfli".
 *
 * Ważne:
 *  - Wszystkie osoby tu wpisane MUSZĄ istnieć w realu (lub być publiczną tożsamością
 *    zespołu redakcyjnego). NIE wpisuj fikcyjnych ekspertów — Google to wykrywa
 *    przez nieaktualne linki sameAs i karze za "fake authorship".
 *  - `sameAs` powinno linkować profile LinkedIn / strony eksperta (jeśli istnieją).
 *  - `slug` używane w URL `/zespol/:slug`.
 *
 * Dopasowanie po `categories`: pierwszy ekspert, którego `categories` zawiera
 * kategorię artykułu – default `helpfli-editorial-team`.
 */

const SEO_EXPERTS = {
  // ZESPÓŁ TECHNICZNY HELPFLI
  'helpfli-editorial-team': {
    id: 'helpfli-editorial-team',
    name: 'Zespół redakcyjny Helpfli',
    slug: 'zespol-redakcyjny',
    role: 'Redakcja Helpfli',
    bio: 'Zespół redakcyjny Helpfli weryfikuje treści poradników razem z licencjonowanymi wykonawcami z naszej platformy.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['*'] // catch-all
  },
  'helpfli-agd-team': {
    id: 'helpfli-agd-team',
    name: 'Helpfli — zespół serwisu AGD',
    slug: 'zespol-serwisu-agd',
    role: 'Eksperci serwisu AGD',
    bio: 'Grupa serwisantów AGD współpracujących z Helpfli, posiadających certyfikaty fabryczne Bosch, Samsung, LG, Electrolux i Whirlpool.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['agd']
  },
  'helpfli-plumbing-team': {
    id: 'helpfli-plumbing-team',
    name: 'Helpfli — zespół hydrauliczny',
    slug: 'zespol-hydrauliczny',
    role: 'Hydraulicy z uprawnieniami',
    bio: 'Hydraulicy z uprawnieniami SEP i gazowymi, weryfikowani w procesie KYC Helpfli.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['hydraulik', 'ogrzewanie']
  },
  'helpfli-electric-team': {
    id: 'helpfli-electric-team',
    name: 'Helpfli — zespół elektryków',
    slug: 'zespol-elektrykow',
    role: 'Elektrycy z uprawnieniami SEP E i D',
    bio: 'Elektrycy z uprawnieniami SEP do 1 kV (E) i nadzoru (D), współpracujący z Helpfli.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['elektryk']
  },
  'helpfli-hvac-team': {
    id: 'helpfli-hvac-team',
    name: 'Helpfli — zespół klimatyzacji',
    slug: 'zespol-klimatyzacji',
    role: 'Serwisanci klimatyzacji F-gaz',
    bio: 'Serwisanci klimatyzacji z aktywnym certyfikatem F-gazowym, weryfikowani w Helpfli.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['klimatyzacja']
  },
  'helpfli-renovation-team': {
    id: 'helpfli-renovation-team',
    name: 'Helpfli — zespół wykończeniowy',
    slug: 'zespol-wykonczeniowy',
    role: 'Eksperci remontów i wykończeń',
    bio: 'Wykonawcy remontów i wykończeń wnętrz z doświadczeniem powyżej 5 lat, weryfikowani na podstawie portfolio.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['remont', 'stolarz']
  },
  'helpfli-cleaning-team': {
    id: 'helpfli-cleaning-team',
    name: 'Helpfli — zespół sprzątania',
    slug: 'zespol-sprzatania',
    role: 'Firmy sprzątające',
    bio: 'Profesjonalne firmy sprzątające współpracujące z Helpfli – sprzątanie po remoncie, pranie tapicerek, kompleksowe usługi.',
    url: 'https://helpfli.pl/about',
    sameAs: [],
    categories: ['sprzatanie']
  }
};

const CATEGORY_TO_EXPERT = (() => {
  const map = {};
  for (const ex of Object.values(SEO_EXPERTS)) {
    if (!Array.isArray(ex.categories)) continue;
    for (const c of ex.categories) {
      if (c === '*') continue;
      if (!map[c]) map[c] = ex.id;
    }
  }
  return map;
})();

function getExpertByCategory(category) {
  const id = CATEGORY_TO_EXPERT[String(category || '').toLowerCase()] || 'helpfli-editorial-team';
  return SEO_EXPERTS[id];
}

function getExpertById(id) {
  return SEO_EXPERTS[id] || null;
}

function listExperts() {
  return Object.values(SEO_EXPERTS);
}

module.exports = {
  SEO_EXPERTS,
  getExpertByCategory,
  getExpertById,
  listExperts
};
