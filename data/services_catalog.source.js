// Jedno źródło prawdy: kategorie + podkategorie (z Twojej tabeli)
module.exports = [
  { id: "hydraulika", label: "Hydraulika", children: [
    "Udrażnianie odpływów i kanalizacji",
    "Naprawa wycieku",
    "Podłączenie zmywarki / pralki (biały montaż)",
    "Wymiana WC / spłuczki / mechanizmu",
    "Lokalizacja wycieków (kamery, czujniki)",
    "Odpowietrzanie i regulacja instalacji c.o.",
    "Wymiana/serwis grzejników i termostatów",
    "Inne"
  ]},
  { id: "elektryka", label: "Elektryka", children: [
    "Montaż gniazdek / włączników / oświetlenia (LED)",
    "Wymiana bezpieczników / naprawa rozdzielni",
    "Pomiary elektryczne i protokoły",
    "Smart Home (Tuya/Sonoff) – konfiguracja",
    "Stacje ładowania EV – montaż/przegląd",
    "RTV/SAT – okablowanie, anteny, wzmacniacze",
    "Inne"
  ]},
  { id: "agd-rtv", label: "AGD i RTV", children: [
    "Montaż TV na ścianie + okablowanie",
    "Konfiguracja Smart TV / soundbar / multiroom",
    "Instalacja okapu / zabudowa AGD",
    "Naprawa AGD",
    "Naprawa RTV",
    "Inne"
  ]},
  { id: "klimatyzacja-ogrzewanie", label: "Klimatyzacja i ogrzewanie", children: [
    "Montaż klimatyzacji",
    "Nabicie/serwis czynnika, odgrzybianie",
    "Serwis pomp ciepła",
    "Regulacja/serwis instalacji c.o., sterowniki/termostaty",
    "Kominiarz – przeglądy okresowe",
    "Inne"
  ]},
  { id: "remont-wykonczenia", label: "Remont i wykończenia", tier: "medium", children: [
    { name: "Remont mieszkania (kompleks)", base_price_min: 40000, base_price_max: 150000, offerOnlySuggested: true },
    { name: "Remont kuchni", base_price_min: 15000, base_price_max: 45000 },
    { name: "Remont łazienki", base_price_min: 8000, base_price_max: 35000 },
    "Malowanie",
    "Gładzie / szpachlowanie / naprawy ścian",
    "Zabudowy GK / sufity podwieszane",
    "Tynki / gips / płyty",
    "Montaż drzwi / ościeżnic / rolet i karniszy",
    "Silikonowanie, fugi, drobne uszczelnienia",
    "Cyklinowanie / renowacja podłóg",
    "Posadzki żywiczne / mikrocement",
    "Montaż paneli",
    "Glazura",
    "Naprawa okien",
    "Tapetowanie ścian",
    "Montaż listew",
    "Inne"
  ]},
  { id: "stolarstwo-montaz", label: "Stolarstwo i montaż", children: [
    "Składanie mebli",
    "Naprawa/dopasowanie drzwi, zawiasów, prowadnic",
    "Blaty kuchenne, półki na wymiar",
    "Zabudowy i szafy wnękowe (prosty montaż)",
    "Listwy przypodłogowe, progi, cokoły",
    "Montaż karniszy / rolet / żaluzji",
    "Inne"
  ]},
  { id: "slusarz-zabezpieczenia", label: "Ślusarz i zabezpieczenia", children: [
    "Awaryjne otwieranie drzwi",
    "Wymiana zamka",
    "Montaż zamków antywłamaniowych",
    "Wizjery / wideodomofony / samozamykacze",
    "Sejfy – montaż/serwis",
    "Naprawa rolet zewnętrznych (zabezpieczenia)",
    "Inne"
  ]},
  { id: "sprzatanie", label: "Sprzątanie", children: [
    "Sprzątanie mieszkania",
    "Sprzątanie po remoncie / po wyprowadzce",
    "Sprzątanie biur / lokali usługowych",
    "Pranie dywanów / materacy / ozonowanie",
    "Mycie okien",
    "Pranie tapicerki",
    "Sprzątanie piwnic/strychów",
    "Inne"
  ]},
  { id: "dom-ogrod", label: "Dom i ogród", children: [
    "Pielęgnacja ogrodu",
    "Projekt ogrodu (koncepcja + nasadzenia)",
    "Mała architektura (taras, pergola, ścieżki)",
    "Koncepcja systemu nawadniania",
    "Zakładanie trawnika / wertykulacja / aeracja",
    "Systemy nawadniania – montaż/serwis",
    "Montaż/naprawa ogrodzeń i bram",
    "Altany / tarasy – naprawy i olejowanie",
    "Odśnieżanie",
    "Koszenie trawnika",
    "Przycinanie krzewów",
    "Usuwanie gniazd os/szerszeni",
    "Czyszczenie pieca",
    "Czyszczenie dachu",
    "Grabienie liści",
    "Moskitiery",
    "Inne"
  ]},
  { id: "auto-mobilne", label: "Auto mobilne", children: [
    "Wymiana akumulatora",
    "Wymiana koła",
    "Wymiana opon/koła na miejscu (sezonowo)",
    "Rozruch z kabli",
    "Holowanie / 'laweta light' w mieście",
    "Diagnostyka OBD (proste odczyty)",
    "Wymiana żarówek / wycieraczek / bezpieczników",
    "Myjnia mobilna / szybkie detailing mini",
    "Dowóz paliwa",
    "Inne"
  ]},
  { id: "it", label: "IT", children: [
    "Naprawa laptopów/PC (czyszczenie, termopasty)",
    "Instalacja systemu, sterowników, Office",
    "Usuwanie wirusów / malware",
    "Konfiguracja Wi-Fi / drukarki / sieci mesh",
    "Backup w chmurze, odzysk podstawowy danych",
    "Konfiguracja telefonu / migracja danych",
    "Smart Home – konfiguracja aplikacji i scen",
    "Inne"
  ]},
  { id: "zdrowie", label: "Zdrowie", children: [
    "Telekonsultacja lekarza",
    "Wizyty domowe (opieka podstawowa)",
    "Wizyty pielęgniarskie (zastrzyki, opatrunki)",
    "Fizjoterapeuta domowy",
    "Asystent seniora / towarzyszenie",
    "Inne"
  ]},
  { id: "zwierzeta", label: "Zwierzęta", children: [
    "Konsultacja weterynaryjna",
    "Wyprowadzanie psa (regularnie / jednorazowo)",
    "Opieka dzienna / wyjazdowa (pet sitting)",
    "Wizyty karmienie / czyszczenie kuwety",
    "Transport do weterynarza",
    "Groomer mobilny / strzyżenie",
    "Behawiorysta / trening podstawowy",
    "Weterynarz domowy",
    "Inne"
  ]},
  { id: "dezynsekcja-szkodniki", label: "Dezynsekcja/szkodniki", children: [
    "Zwalczanie pluskiew / karaluchów / prusaków",
    "Zwalczanie mrówek / rybików",
    "Osy / szerszenie – bezpieczne usuwanie",
    "Deratyzacja (gryzonie) + monitoring HACCP",
    "Zabezpieczenia po inwazji (siatki, uszczelnienia)",
    "Inne"
  ]},
  { id: "przeprowadzki-transport", label: "Przeprowadzki i transport", children: [
    "Taxi bagażowe (małe przeprowadzki)",
    "Transport gabarytów",
    "Demontaż/montaż mebli, pakowanie",
    "Wnoszenie / znoszenie (ekipy)",
    "Kurier miejski (ekspres lokalny)",
    "Inne"
  ]},
  { id: "gaz", label: "Gaz", children: [
    "Przegląd instalacji",
    "Wyciek gazu",
    "Montaż kuchenki gazowej",
    "Wymiana reduktorów / węży",
    "Próby szczelności i protokoły",
    "Inne"
  ]},
  { id: "wywoz-utylizacja", label: "Wywóz/utylizacja", children: [
    "Wywóz gruzu / kontener",
    "Wywóz gabarytów / mebli",
    "Utylizacja elektrośmieci (AGD/RTV)",
    "Wywóz zieleni / gałęzi",
    "Czyszczenie piwnic/strychów",
    "Wywóz złomu",
    "Wywóz fekalii",
    "Inne"
  ]},
  { id: "pomoc-24-7", label: "Pomoc 24/7", children: [
    "Awaria hydrauliczna (wyciek)",
    "Awaria elektryczna (zabezpieczenia)",
    "Awaryjne otwieranie drzwi (ślusarz)",
    "Pomoc drogowa / rozruch / koło",
    "Zabezpieczenie po zalaniu / dachu",
    "Inne"
  ]},
  { id: "zlota-raczka", label: "Złota rączka", children: [
    "Montaż TV / karniszy / rolet / obrazów",
    "Drobne naprawy w domu (zawiasy, zamki meblowe)",
    "Silikonowanie, uszczelnienia, poprawki",
    "Skręcanie mebli / półki / uchwyty",
    "„Godzina dla domu” (mix drobiazgów)"
  ]},
  { id: "codzienne-sprawy", label: "Codzienne sprawy", children: [
    "Zakupy na szybko",
    "Odbiór/zwrot paczek",
    "Pomoc przy przeprowadzce light (pudełka)",
    "Drobne porządki",
    "Inne"
  ]},
  { id: "urzedy-formalnosci", label: "Urzędy i formalności", children: [
    "Wypełnianie wniosków / ePUAP / profil zaufany",
    "Rejestracja auta / dowód rejestracyjny",
    "Tłumaczenie krótkich pism (nie-przysięgłe)",
    "Umawianie wizyt / rezerwacje",
    "Inne"
  ]},
  { id: "edukacja-korepetycje", label: "Edukacja i korepetycje", children: [
    "Matematyka / języki / matura",
    "Nauka obsługi komputera/telefonu",
    "Pomoc „zadania domowe”",
    "Kursy krótkie (Excel, CV/LinkedIn)",
    "Inne"
  ]},
  { id: "rower-hulajnoga", label: "Rower / hulajnoga", children: [
    "Serwis roweru (hamulce, przerzutki)",
    "Wymiana dętki / opony",
    "Konserwacja hulajnogi elektrycznej",
    "Inne"
  ]},
  { id: "monitoring-alarms", label: "Monitoring i alarmy (zabezpieczenia domu)", children: [
    "Montaż kamer / wideodomofonów",
    "Konfiguracja alarmu / czujników",
    "Inne"
  ]},
  { id: "akwarystyka", label: "Akwarystyka", children: [
    "Zakładanie i start akwarium",
    "Aranżacja / aquascaping",
    "Podmiany wody i serwis cykliczny",
    "Inne"
  ]},
  { id: "wynajem", label: "Wynajem", children: [
    "Wynajem przyczep i lawe",
    "Wynajem maszyn budowlanych",
    "Wynajem narzędzi i ogrodowych",
    "Wynajem foto-video/AV",
    "Wynajem sprzętu eventowego",
    "Wynajem sport/outdoor",
    "Wynajem samochodu",
    "Inne"
  ]},
  { id: "architektura", label: "Architektura", tier: "large", offerOnlySuggested: true, children: [
    "Konsultacje online",
    "Projekt koncepcyjny mieszkania/pokoju",
    "Wizualizacje 3D",
    "Inwentaryzacja pomiarowa 2D/3D",
    "Audyt funkcjonalny lokalu/usługu (układ ścian, strefy)",
    { name: "Projekt budowlany / przebudowa", offerOnlySuggested: true, base_price_min: 15000, base_price_max: 80000 }
  ]},
  { id: "budowa-inwestycje", label: "Budowa i inwestycje", tier: "large", offerOnlySuggested: true, children: [
    { name: "Budowa domu", base_price_min: 450000, base_price_max: 850000 },
    { name: "Dom pod klucz", base_price_min: 500000, base_price_max: 950000 },
    { name: "Stan surowy", base_price_min: 200000, base_price_max: 450000 },
    { name: "Generalny remont domu", base_price_min: 80000, base_price_max: 350000 },
    { name: "Wykończenie wnętrz (kompleks)", base_price_min: 50000, base_price_max: 200000 },
    { name: "Budowa hali / obiektu", base_price_min: 300000, base_price_max: 2000000 },
    { name: "Generalny wykonawca", base_price_min: 100000, base_price_max: 500000 },
    { name: "Fotowoltaika (instalacja)", base_price_min: 25000, base_price_max: 80000 },
    { name: "Budowa basenu", base_price_min: 80000, base_price_max: 250000 },
    { name: "Budowa ogrodu od zera", base_price_min: 30000, base_price_max: 120000 },
    "Inne"
  ]},
  { id: "nieruchomosci", label: "Nieruchomości", tier: "medium", offerOnlySuggested: true, children: [
    { name: "Odbiór mieszkania / domu", base_price_min: 800, base_price_max: 3500 },
    { name: "Rzeczoznawca majątkowy", base_price_min: 1500, base_price_max: 8000 },
    { name: "Inspekcja domu / lokalu", base_price_min: 600, base_price_max: 2500 },
    { name: "Kosztorys / wycena robót", base_price_min: 2000, base_price_max: 15000 },
    { name: "Geodeta / mapa", base_price_min: 800, base_price_max: 5000 },
    "Inne"
  ]},
  { id: "motoryzacja-rozszerzona", label: "Motoryzacja", tier: "medium", children: [
    { name: "Mechanik mobilny", base_price_min: 150, base_price_max: 800 },
    { name: "Lakiernik / naprawa blacharska", base_price_min: 500, base_price_max: 8000 },
    { name: "Detailing", base_price_min: 200, base_price_max: 1500 },
    { name: "Diagnostyka komputerowa", base_price_min: 100, base_price_max: 400 },
    "Inne"
  ]},
  { id: "eventy", label: "Eventy", tier: "medium", children: [
    { name: "DJ / oprawa muzyczna", base_price_min: 800, base_price_max: 5000 },
    { name: "Fotograf", base_price_min: 600, base_price_max: 4000 },
    { name: "Animator / animatorzy", base_price_min: 400, base_price_max: 2500 },
    "Inne"
  ]},
  { id: "prawo-biznes", label: "Prawo i biznes", tier: "medium", b2b: true, children: [
    { name: "Księgowość / rozliczenia", base_price_min: 300, base_price_max: 3000, b2b: true },
    { name: "Kontroling / finanse", base_price_min: 500, base_price_max: 5000, b2b: true },
    { name: "Software house / wdrożenia IT", base_price_min: 5000, base_price_max: 100000, b2b: true },
    { name: "Fit-out biur", base_price_min: 50000, base_price_max: 500000, b2b: true, offerOnlySuggested: true },
    { name: "Prawnik / konsultacja", base_price_min: 200, base_price_max: 2000 },
    { name: "Doradca kredytowy", base_price_min: 0, base_price_max: 0 },
    { name: "Notariusz", base_price_min: 100, base_price_max: 500 },
    "Inne"
  ]},
  { id: "inne", label: "Inne", children: [
    "Inne opisz problem"
  ]}
];





