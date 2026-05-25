/**
 * Seed list mocnych tematów SEO dla Helpfli "Poradniki AI".
 *
 * Zasada doboru:
 *  - frazy z realnym wolumenem w PL (kody błędów AGD, „cieknący kran",
 *    „ile kosztuje hydraulik/elektryk" + miasta TOP 10),
 *  - tematy z wysoką intencją zakupową (ktoś szuka pomocy = potencjalny klient Helpfli),
 *  - zbalansowane kategorie: AGD, hydraulik, elektryk, ogrzewanie, remont, sprzątanie, ogród.
 *
 * Lista służy:
 *  - jako bootstrap przy pustej kolekcji (admin "Wygeneruj 50 startowych"),
 *  - jako pula dla cron job (losuje N tematów, których jeszcze nie wygenerowano).
 *
 * Każdy element to obiekt { topic, category, keywords? } – `topic` trafia w prompt 1:1.
 */

const SEO_SEED_TOPICS = [
  // --- Pralki / suszarki (kody błędów = supermocne SEO) ---
  { topic: 'Pralka błąd E20 – co oznacza i jak naprawić', category: 'agd', keywords: ['pralka e20', 'błąd e20', 'pralka nie odpompowuje'] },
  { topic: 'Pralka błąd E10 – diagnoza i naprawa', category: 'agd', keywords: ['pralka e10', 'pralka nie nabiera wody'] },
  { topic: 'Pralka błąd F03 – co robić', category: 'agd', keywords: ['pralka f03'] },
  { topic: 'Pralka błąd E40 – otwarte drzwi i blokada', category: 'agd', keywords: ['pralka e40', 'blokada drzwi pralki'] },
  { topic: 'Pralka nie wiruje – najczęstsze przyczyny', category: 'agd', keywords: ['pralka nie wiruje', 'pralka nie odwirowuje'] },
  { topic: 'Pralka głośno pracuje przy wirowaniu – diagnoza', category: 'agd', keywords: ['pralka głośno wiruje', 'pralka huczy'] },
  { topic: 'Pralka cieknie od dołu – co sprawdzić', category: 'agd', keywords: ['pralka cieknie', 'pralka leje wodę'] },
  { topic: 'Pralka nie włącza się – co zrobić', category: 'agd', keywords: ['pralka nie startuje', 'pralka nie reaguje'] },

  // --- Zmywarki ---
  { topic: 'Zmywarka błąd E24 – co oznacza i jak naprawić', category: 'agd', keywords: ['zmywarka e24', 'błąd e24 bosch'] },
  { topic: 'Zmywarka błąd E15 – woda w wannie', category: 'agd', keywords: ['zmywarka e15', 'aquastop zmywarka'] },
  { topic: 'Zmywarka błąd E22 – problem z odpływem', category: 'agd', keywords: ['zmywarka e22'] },
  { topic: 'Zmywarka nie myje dobrze – diagnoza krok po kroku', category: 'agd', keywords: ['zmywarka nie myje', 'zmywarka źle myje'] },
  { topic: 'Zmywarka nie odpompowuje wody – co robić', category: 'agd', keywords: ['zmywarka nie odpompowuje'] },
  { topic: 'Zmywarka nie suszy naczyń – przyczyny', category: 'agd', keywords: ['zmywarka nie suszy'] },

  // --- Lodówki / zamrażarki ---
  { topic: 'Lodówka nie chłodzi – diagnoza krok po kroku', category: 'agd', keywords: ['lodówka nie chłodzi'] },
  { topic: 'Lodówka głośno pracuje – co oznacza i jak naprawić', category: 'agd', keywords: ['lodówka głośno pracuje', 'lodówka buczy'] },
  { topic: 'Lodówka cieknie woda – najczęstsze przyczyny', category: 'agd', keywords: ['lodówka cieka', 'woda w lodówce'] },
  { topic: 'Zamrażarka się rozmraża – co robić', category: 'agd', keywords: ['zamrażarka nie mrozi', 'rozmrażanie zamrażarki'] },
  { topic: 'Awaria lodówki – kiedy naprawa, kiedy nowa lodówka', category: 'agd', keywords: ['awaria lodówki', 'naprawa lodówki'] },

  // --- Piekarniki / kuchenki / mikrofale ---
  { topic: 'Piekarnik nie grzeje – co sprawdzić', category: 'agd', keywords: ['piekarnik nie grzeje'] },
  { topic: 'Płyta indukcyjna błąd E – co oznacza', category: 'agd', keywords: ['płyta indukcyjna błąd', 'indukcja błąd e'] },
  { topic: 'Mikrofalówka nie podgrzewa – diagnoza', category: 'agd', keywords: ['mikrofalówka nie podgrzewa'] },
  { topic: 'Naprawa AGD Warszawa – ile kosztuje i jak wybrać serwis', category: 'agd', keywords: ['naprawa agd warszawa', 'serwis agd warszawa'] },
  { topic: 'Naprawa AGD Kraków – ile kosztuje i jak wybrać serwis', category: 'agd', keywords: ['naprawa agd kraków'] },

  // --- Hydraulik – problemy domowe ---
  { topic: 'Cieknący kran – jak naprawić krok po kroku', category: 'hydraulik', keywords: ['cieknący kran', 'kran cieknie'] },
  { topic: 'Jak odetkać zlew w kuchni – domowe sposoby', category: 'hydraulik', keywords: ['jak odetkać zlew', 'zatkany zlew'] },
  { topic: 'Zatkana toaleta – jak udrożnić', category: 'hydraulik', keywords: ['zatkana toaleta', 'jak udrożnić toaletę'] },
  { topic: 'Cieknący spłuczka – diagnoza i naprawa', category: 'hydraulik', keywords: ['spłuczka cieka', 'naprawa spłuczki'] },
  { topic: 'Niskie ciśnienie wody w kranie – co robić', category: 'hydraulik', keywords: ['niskie ciśnienie wody', 'słabe ciśnienie wody'] },
  { topic: 'Wymiana baterii kuchennej – krok po kroku', category: 'hydraulik', keywords: ['wymiana baterii kuchennej'] },
  { topic: 'Wymiana syfonu pod zlewem – instrukcja', category: 'hydraulik', keywords: ['wymiana syfonu'] },
  { topic: 'Cieknąca rura pod zlewem – co robić', category: 'hydraulik', keywords: ['cieknąca rura', 'rura pod zlewem cieka'] },
  { topic: 'Bojler nie grzeje wody – diagnoza', category: 'hydraulik', keywords: ['bojler nie grzeje'] },

  // --- Hydraulik – cenniki + miasta (high-intent) ---
  { topic: 'Ile kosztuje hydraulik w Warszawie w 2026 roku', category: 'hydraulik', keywords: ['ile kosztuje hydraulik warszawa', 'cennik hydraulika warszawa'] },
  { topic: 'Ile kosztuje hydraulik w Krakowie – aktualne stawki', category: 'hydraulik', keywords: ['ile kosztuje hydraulik kraków'] },
  { topic: 'Ile kosztuje hydraulik w Poznaniu – cennik usług', category: 'hydraulik', keywords: ['ile kosztuje hydraulik poznań'] },
  { topic: 'Ile kosztuje hydraulik we Wrocławiu', category: 'hydraulik', keywords: ['ile kosztuje hydraulik wrocław'] },
  { topic: 'Ile kosztuje hydraulik w Gdańsku', category: 'hydraulik', keywords: ['ile kosztuje hydraulik gdańsk'] },
  { topic: 'Ile kosztuje udrożnienie rury – cennik 2026', category: 'hydraulik', keywords: ['ile kosztuje udrożnienie rury'] },
  { topic: 'Ile kosztuje wymiana baterii łazienkowej', category: 'hydraulik', keywords: ['wymiana baterii łazienkowej cena'] },

  // --- Elektryk – problemy domowe ---
  { topic: 'Bezpieczniki wyskakują – co robić i jak znaleźć przyczynę', category: 'elektryk', keywords: ['bezpieczniki wyskakują', 'wybija bezpiecznik'] },
  { topic: 'Brak prądu w jednym pokoju – diagnoza', category: 'elektryk', keywords: ['brak prądu w pokoju'] },
  { topic: 'Gniazdko iskrzy – co oznacza i jak postąpić', category: 'elektryk', keywords: ['gniazdko iskrzy', 'iskrzy kontakt'] },
  { topic: 'Wymiana włącznika światła – krok po kroku', category: 'elektryk', keywords: ['wymiana włącznika światła'] },
  { topic: 'Wymiana gniazdka 230V – instrukcja bezpieczna', category: 'elektryk', keywords: ['wymiana gniazdka'] },
  { topic: 'Migające światło w mieszkaniu – przyczyny', category: 'elektryk', keywords: ['miga światło', 'lampa miga'] },
  { topic: 'Bezpiecznik różnicowoprądowy – co to i kiedy wybija', category: 'elektryk', keywords: ['różnicówka', 'bezpiecznik różnicowoprądowy'] },
  { topic: 'Podłączenie indukcji do prądu – co trzeba wiedzieć', category: 'elektryk', keywords: ['podłączenie indukcji', 'instalacja do indukcji'] },

  // --- Elektryk – cenniki + miasta ---
  { topic: 'Ile kosztuje elektryk w Warszawie – cennik 2026', category: 'elektryk', keywords: ['ile kosztuje elektryk warszawa'] },
  { topic: 'Ile kosztuje elektryk w Krakowie', category: 'elektryk', keywords: ['ile kosztuje elektryk kraków'] },
  { topic: 'Ile kosztuje elektryk we Wrocławiu', category: 'elektryk', keywords: ['ile kosztuje elektryk wrocław'] },
  { topic: 'Ile kosztuje elektryk w Poznaniu', category: 'elektryk', keywords: ['ile kosztuje elektryk poznań'] },
  { topic: 'Ile kosztuje wymiana instalacji elektrycznej w mieszkaniu', category: 'elektryk', keywords: ['wymiana instalacji elektrycznej cena'] },

  // --- Ogrzewanie / klimatyzacja ---
  { topic: 'Jak odpowietrzyć kaloryfer – instrukcja krok po kroku', category: 'ogrzewanie', keywords: ['jak odpowietrzyć kaloryfer', 'odpowietrzanie grzejnika'] },
  { topic: 'Kaloryfer zimny na dole, ciepły na górze – co robić', category: 'ogrzewanie', keywords: ['kaloryfer zimny na dole'] },
  { topic: 'Piec gazowy się blokuje – najczęstsze przyczyny', category: 'ogrzewanie', keywords: ['piec gazowy się blokuje'] },
  { topic: 'Brak ciepłej wody z pieca – co sprawdzić', category: 'ogrzewanie', keywords: ['piec nie grzeje wody'] },
  { topic: 'Przegląd pieca gazowego – co obejmuje i ile kosztuje', category: 'ogrzewanie', keywords: ['przegląd pieca gazowego cena'] },
  { topic: 'Klimatyzator nie chłodzi – diagnoza krok po kroku', category: 'klimatyzacja', keywords: ['klimatyzator nie chłodzi'] },
  { topic: 'Serwis klimatyzacji – jak często i ile kosztuje', category: 'klimatyzacja', keywords: ['serwis klimatyzacji cena'] },

  // --- Remont / wykończenie ---
  { topic: 'Ile kosztuje malowanie mieszkania w 2026 roku', category: 'remont', keywords: ['ile kosztuje malowanie mieszkania'] },
  { topic: 'Ile kosztuje położenie płytek – cennik 2026', category: 'remont', keywords: ['cena układania płytek'] },
  { topic: 'Ile kosztuje remont łazienki', category: 'remont', keywords: ['ile kosztuje remont łazienki'] },
  { topic: 'Ile kosztuje remont kuchni – cennik 2026', category: 'remont', keywords: ['ile kosztuje remont kuchni'] },
  { topic: 'Glazurnik czy fachowiec ogólny – kogo wybrać', category: 'remont', keywords: ['glazurnik'] },
  { topic: 'Skucie starych płytek – ile kosztuje i jak się przygotować', category: 'remont', keywords: ['skuwanie płytek cena'] },
  { topic: 'Tapeta czy farba – co bardziej się opłaca', category: 'remont', keywords: ['tapeta czy farba'] },

  // --- Stolarz / drzwi / okna ---
  { topic: 'Drzwi się nie zamykają poprawnie – jak wyregulować', category: 'stolarz', keywords: ['regulacja drzwi'] },
  { topic: 'Okno PCV nie domyka – regulacja okuć', category: 'stolarz', keywords: ['regulacja okna pcv', 'okno nie domyka'] },
  { topic: 'Wymiana zamka w drzwiach – krok po kroku', category: 'stolarz', keywords: ['wymiana zamka'] },
  { topic: 'Zacinają się drzwi – co zrobić', category: 'stolarz', keywords: ['zacinają się drzwi'] },

  // --- Sprzątanie / dezynsekcja / pranie tapicerki ---
  { topic: 'Pranie kanapy w domu – jak wybrać firmę', category: 'sprzatanie', keywords: ['pranie kanapy cena'] },
  { topic: 'Sprzątanie po remoncie – cennik i co obejmuje', category: 'sprzatanie', keywords: ['sprzątanie po remoncie cena'] },
  { topic: 'Pluskwy w mieszkaniu – jak się pozbyć', category: 'dezynsekcja', keywords: ['pluskwy mieszkanie'] },
  { topic: 'Mrówki w domu – jak się pozbyć', category: 'dezynsekcja', keywords: ['mrówki w domu'] },

  // --- Ogród / drobne usługi ---
  { topic: 'Koszenie trawnika – ile kosztuje usługa', category: 'ogrod', keywords: ['koszenie trawnika cena'] },
  { topic: 'Przycinanie drzew – kiedy i ile kosztuje', category: 'ogrod', keywords: ['przycinanie drzew cena'] },

  // --- Komputery / IT (drobnica do internetu) ---
  { topic: 'Komputer nie włącza się – diagnoza krok po kroku', category: 'it', keywords: ['komputer nie włącza się'] },
  { topic: 'Wolny internet w domu – co sprawdzić', category: 'it', keywords: ['wolny internet'] },

  // --- Meta-poradniki, na których Helpfli wygrywa zaufanie ---
  { topic: 'Jak wybrać dobrego hydraulika – 7 sygnałów ostrzegawczych', category: 'porady', keywords: ['jak wybrać hydraulika'] },
  { topic: 'Jak wybrać dobrego elektryka – na co zwrócić uwagę', category: 'porady', keywords: ['jak wybrać elektryka'] },
  { topic: 'Jak rozpoznać uczciwego fachowca – checklist', category: 'porady', keywords: ['uczciwy fachowiec'] },
  { topic: 'Ile dawać napiwku fachowcowi w Polsce', category: 'porady', keywords: ['napiwek fachowiec'] }
];

const SEO_SEED_BY_CATEGORY = SEO_SEED_TOPICS.reduce((acc, item) => {
  const cat = item.category || 'inne';
  if (!acc[cat]) acc[cat] = [];
  acc[cat].push(item);
  return acc;
}, {});

const SEO_CATEGORIES = Object.keys(SEO_SEED_BY_CATEGORY);

module.exports = {
  SEO_SEED_TOPICS,
  SEO_SEED_BY_CATEGORY,
  SEO_CATEGORIES
};
